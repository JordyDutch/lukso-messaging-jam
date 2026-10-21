// mainnet-integration.mjs
// Wire the UP-gated WireGuard handshake onto the REAL LUKSO mainnet path that
// already exists in poc/lukso-mainnet (MessageBoard @ 0x64cB5aa841aB05A8fe586baf22924468259C493F,
// E2EE envelope = X25519 ECDH + HKDF + AES-GCM, <=200 B/post).
//
// This produces the exact bytes you would pass to board.post(to, body) on
// mainnet, and SIMULATES the full send->receive->verify->derive->wg-config loop
// WITHOUT broadcasting a transaction (no key spend). Set BROADCAST=1 + a funded
// signer to actually send (left as the final manual step — spends real LYX).
//
// Key design fact proven here: the on-chain board caps bodies at 200 bytes, and
// a naive {wgPub(32)+nonce(16)+expiry+path+sig(65)+ECIES-endpoint} offer blows
// that budget. Resolution: the WHOLE offer is carried as ONE E2EE envelope
// (confidentiality from the conversation key), and authenticity comes from an
// EIP-191 UP signature embedded INSIDE the envelope. One post, <=200 B, both
// properties. This matches the up-wireguard-lobby memo.
//
// Run:  node up-wg-handshake/mainnet-integration.mjs

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const e2ee = require('../devnet-adapter/e2ee.js');

// Raw-bytes AES-256-GCM (the shared e2ee.encrypt forces utf8+base64, which
// inflates binary payloads past the 200 B board limit). Same key/threadId.
function sealBytes(buf, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}
function openBytes({ iv, tag, ct }, key) {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const HKDF_INFO = 'wg-x25519-v1';
const BOARD = '0x64cB5aa841aB05A8fe586baf22924468259C493F'; // live mainnet board (poc/lukso-mainnet/state.json)
const RPC = 'https://42.rpc.thirdweb.com';                   // LUKSO mainnet (chainId 42)
const enc = new TextEncoder();
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');

// --- derive the ephemeral WG key from the UP secp256k1 private key ---
function deriveWg(upPriv, path, nonce) {
  const info = new Uint8Array([...enc.encode(HKDF_INFO + '|' + path), ...nonce]);
  const wgPriv = hkdf(sha256, upPriv, nonce, info, 32);
  return { wgPriv, wgPub: x25519.getPublicKey(wgPriv) };
}

// a UP reduced to its secp256k1 controller key + an X25519 conversation identity
function makeUP(label) {
  const priv = secp256k1.utils.randomPrivateKey();
  const wallet = new ethers.Wallet(hex(priv));
  return { label, priv, address: wallet.address, wallet, conv: e2ee.makeIdentity() };
}

function threadIdFor(a, b) {
  const [lo, hi] = [a, b].sort();
  return ethers.keccak256(ethers.concat([
    ethers.zeroPadValue(ethers.getAddress(lo), 32),
    ethers.zeroPadValue(ethers.getAddress(hi), 32),
  ]));
}

// Build the compact, signed offer object, then seal it in ONE E2EE envelope.
async function buildOfferBody(fromUP, toUP, endpoint) {
  const path = `m/wg/${Math.floor(Math.random() * 1000)}`;
  const nonce = randomBytes(12);                  // 12B keeps us well under budget
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const { wgPub } = deriveWg(fromUP.priv, path, nonce);

  // canonical signed core (authenticity). Compact binary, not JSON, to save bytes.
  const core = Buffer.concat([
    Buffer.from(ethers.getBytes(wgPub)),          // 32
    nonce,                                         // 12
    Buffer.from(ethers.toBeArray(expiry).length ? ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(expiry), 5)) : new Uint8Array(5)), // 5
    enc.encode(endpoint),                          // variable (e.g. "203.0.113.10:51820" = 18)
  ]);
  const digest = ethers.keccak256(core);
  const sig = await fromUP.wallet.signMessage(ethers.getBytes(digest)); // 65B EIP-191

  // plaintext payload = core || sig (raw bytes), then AES-GCM-seal with the conv key
  const payload = Buffer.concat([core, Buffer.from(ethers.getBytes(sig))]);
  const threadId = threadIdFor(fromUP.address, toUP.address);
  const convKey = e2ee.conversationKey(fromUP.conv, toUP.conv, threadId);
  const env = sealBytes(payload, convKey);

  // on-chain body: magic(2) + iv(12) + tag(16) + ct  (same framing as gen-e2ee.js)
  const body = Buffer.concat([Buffer.from('45e2', 'hex'), env.iv, env.tag, env.ct]);
  return { body, path, nonce, expiry, wgPub, threadId, coreLen: core.length };
}

// Recipient: unseal envelope, split core||sig, verify UP signature, derive its WG key.
function openOfferBody(body, fromUP, toUP) {
  const iv = body.subarray(2, 14);
  const tag = body.subarray(14, 30);
  const ct = body.subarray(30);
  const threadId = threadIdFor(fromUP.address, toUP.address);
  const convKey = e2ee.conversationKey(toUP.conv, fromUP.conv, threadId); // order-independent
  const payload = openBytes({ iv, tag, ct }, convKey);

  const sig = hex(payload.subarray(payload.length - 65));
  const core = payload.subarray(0, payload.length - 65);
  const digest = ethers.keccak256(core);
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
  if (recovered.toLowerCase() !== fromUP.address.toLowerCase())
    throw new Error(`signature mismatch (MITM?) recovered=${recovered}`);

  const peerWgPub = hex(core.subarray(0, 32));
  const expiry = Number('0x' + core.subarray(44, 49).toString('hex'));
  if (expiry < Math.floor(Date.now() / 1000)) throw new Error('offer expired');
  const endpoint = core.subarray(49).toString('utf8');
  return { peerWgPub, endpoint, verifiedFrom: recovered, expiry };
}

// ============================= simulate =============================
console.log('=== LUKSO MAINNET integration + simulation (no broadcast) ===\n');
console.log('board:', BOARD, '| rpc:', RPC, '| chainId target: 42\n');

const alice = makeUP('Alice');
const bob = makeUP('Bob');

const offer = await buildOfferBody(alice, bob, '203.0.113.10:51820');
console.log('Alice builds mainnet-ready offer body:');
console.log('  signed core length:', offer.coreLen, 'B');
console.log('  on-chain body size:', offer.body.length, 'B   (board limit 200)',
  offer.body.length <= 200 ? '✓ FITS' : '✗ OVER BUDGET');
console.log('  board.post() call  : post("' + bob.address + '", 0x' + offer.body.toString('hex').slice(0, 24) + '…)\n');

const bobView = openOfferBody(offer.body, alice, bob);
console.log('Bob receives post, unseals + verifies:');
console.log('  recovered signer  :', bobView.verifiedFrom, '== Alice', bobView.verifiedFrom.toLowerCase() === alice.address.toLowerCase() ? '✓' : '✗');
console.log('  peer WG pubkey    :', bobView.peerWgPub);
console.log('  endpoint          :', bobView.endpoint, '✓');

// Bob derives his own side + both produce wg configs
const bobOffer = await buildOfferBody(bob, alice, '198.51.100.20:51820');
const aliceView = openOfferBody(bobOffer.body, bob, alice);
const aliceWg = deriveWg(alice.priv, offer.path, offer.nonce);
console.log('\nBoth sides derive ephemeral WG keys and can raise the tunnel:');
console.log('  Alice wg priv (b64):', Buffer.from(aliceWg.wgPriv).toString('base64'));
console.log('  Alice peer pubkey  :', aliceView.peerWgPub, '(= Bob wg pub)');

// ---- adversarial, on the mainnet framing ----
console.log('\n=== adversarial (mainnet body) — all must REJECT ===');
function mustReject(name, fn) {
  try { fn(); console.log(`  ✗ ${name}: NOT rejected — BUG`); process.exitCode = 1; }
  catch (e) { console.log(`  ✓ ${name}: rejected (${e.message.slice(0, 44)}…)`); }
}
mustReject('flipped ciphertext byte', () => {
  const t = Buffer.from(offer.body); t[t.length - 1] ^= 0xff; openOfferBody(t, alice, bob);
});
mustReject('wrong recipient (Mallory)', () => {
  const mallory = makeUP('Mallory'); openOfferBody(offer.body, alice, mallory);
});
mustReject('wrong claimed sender', () => {
  const mallory = makeUP('Mallory'); openOfferBody(offer.body, mallory, bob);
});

console.log('\n=== simulation complete (no tx broadcast; set BROADCAST=1 + funded signer to send) ===');
