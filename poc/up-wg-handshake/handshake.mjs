// PoC: UP-identity-gated ephemeral WireGuard handshake.
//
// Proves the crypto design agreed with B (see memory up-wireguard-lobby):
//   1. Each UP has a secp256k1 controller key (the real, long-lived identity).
//   2. A fresh ephemeral X25519 WireGuard key is DERIVED from that secp256k1
//      PRIVATE key via HKDF (privkey-as-seed -> KDF -> X25519), NOT by curve
//      conversion. Deterministic: same (UP_priv, path) -> same WG key, so a
//      wallet/mobile app can regenerate it with zero stored WG state.
//   3. The connection offer (WG pubkey + path + nonce + expiry + endpoint) is
//      SIGNED by the UP controller key (EIP-191) -> authenticity, no MITM.
//   4. The endpoint is ENCRYPTED (ECIES over secp256k1) to the peer's UP pubkey
//      -> confidentiality of the one thing that must not leak on-chain.
//   5. Peer recovers sender address from the signature, checks it, decrypts the
//      endpoint, derives ITS own WG key the same way, and we have both sides of
//      a WireGuard config bound to verified UP identities.
//
// No network, no chain calls, no real tunnel is raised here — this isolates and
// proves the identity->key layer. NAT traversal + actually bringing up `wg` are
// deliberately out of scope for this PoC (and `wg genkey` interop is checked
// separately in verify-wg-interop.sh).
//
// Run:  node handshake.mjs

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

const HKDF_INFO = 'wg-x25519-v1'; // domain separation: WG key never collides with any other derived key
const enc = new TextEncoder();
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));

// --- A UP, reduced to what matters here: a secp256k1 controller keypair ---
function makeUP(label) {
  const priv = secp256k1.utils.randomPrivateKey();
  const pubUncompressed = secp256k1.getPublicKey(priv, false); // 65B, 0x04||X||Y
  const wallet = new ethers.Wallet(hex(priv));                 // for EIP-191 signing + addr
  return { label, priv, pub: pubUncompressed, address: wallet.address, wallet };
}

// --- Derive the ephemeral WG X25519 key from the UP's secp256k1 PRIVATE key ---
// WG_priv = clamp( HKDF-SHA256(ikm=UP_priv, salt=nonce, info="wg-x25519-v1"||path) )
function deriveWgKeypair(upPriv, path, nonce) {
  const info = new Uint8Array([...enc.encode(HKDF_INFO + '|' + path), ...nonce]);
  const wgPriv = hkdf(sha256, upPriv, nonce /*salt*/, info, 32); // x25519 lib clamps internally
  const wgPub = x25519.getPublicKey(wgPriv);
  return { wgPriv, wgPub };
}

// --- ECIES (secp256k1): encrypt endpoint to recipient UP pubkey ---
// Ephemeral ECDH -> HKDF -> XOR keystream (AES/GCM would be prod; keep PoC dep-free & readable).
function eciesEncrypt(recipientPub, plaintext) {
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false);
  const shared = secp256k1.getSharedSecret(ephPriv, recipientPub); // 33B compressed point
  const key = hkdf(sha256, shared, new Uint8Array(0), enc.encode('ecies-endpoint-v1'), plaintext.length + 32);
  const pt = enc.encode(plaintext);
  const ct = pt.map((b, i) => b ^ key[i]);
  const mac = hkdf(sha256, shared, ct, enc.encode('ecies-mac-v1'), 32); // integrity tag
  return { ephPub: hex(ephPub), ct: hex(ct), mac: hex(mac) };
}
function eciesDecrypt(recipientPriv, box) {
  const shared = secp256k1.getSharedSecret(recipientPriv, unhex(box.ephPub));
  const ct = unhex(box.ct);
  const mac = hkdf(sha256, shared, ct, enc.encode('ecies-mac-v1'), 32);
  if (hex(mac) !== box.mac) throw new Error('ECIES MAC mismatch — tampered or wrong key');
  const key = hkdf(sha256, shared, new Uint8Array(0), enc.encode('ecies-endpoint-v1'), ct.length + 32);
  return new TextDecoder().decode(ct.map((b, i) => b ^ key[i]));
}

// --- Build a signed+encrypted connection offer (this is what rides in LSP8 metadata) ---
async function makeOffer(fromUP, toUP, endpoint) {
  const path = `m/wg/${Math.floor(Math.random() * 1000)}`; // public selector
  const nonce = randomBytes(16);
  const expiry = Math.floor(Date.now() / 1000) + 300; // 5 min TTL
  const { wgPub } = deriveWgKeypair(fromUP.priv, path, nonce);

  // endpoint is the ONLY secret -> ECIES to recipient UP pubkey
  const endpointBox = eciesEncrypt(toUP.pub, endpoint);

  // everything else is public (path/nonce/wgPub are selectors, safe on-chain)
  const offerCore = {
    from: fromUP.address, to: toUP.address,
    wgPub: hex(wgPub), path, nonce: hex(nonce), expiry, endpointBox,
  };
  const digest = canonicalDigest(offerCore); // canonical message
  const signature = await fromUP.wallet.signMessage(ethers.getBytes(digest));
  return { ...offerCore, signature };
}

// Canonical digest over EXACTLY the signed fields. The verifier recomputes this
// from the received fields — it never trusts a digest sent by the peer. This is
// what binds wgPub/endpoint/expiry to the signature (tamper any field -> digest
// changes -> signature no longer recovers `from`).
function canonicalDigest(o) {
  return ethers.id(JSON.stringify({
    from: o.from, to: o.to, wgPub: o.wgPub, path: o.path,
    nonce: o.nonce, expiry: o.expiry, endpointBox: o.endpointBox,
  }));
}

// --- Peer verifies + accepts an offer, derives its own side ---
function verifyOffer(offer, expectedFrom, recipientUP) {
  // 1. authenticity: recompute digest from received fields (never trust a sent digest),
  //    recover signer from EIP-191 signature, must equal claimed `from`
  const digest = canonicalDigest(offer);
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), offer.signature);
  if (recovered.toLowerCase() !== offer.from.toLowerCase())
    throw new Error(`signature does not match from (MITM?) recovered=${recovered}`);
  if (recovered.toLowerCase() !== expectedFrom.toLowerCase())
    throw new Error(`offer is from an unexpected UP: ${recovered}`);
  // 2. freshness
  if (offer.expiry < Math.floor(Date.now() / 1000)) throw new Error('offer expired');
  // 3. confidentiality: only the addressed UP can read the endpoint
  const endpoint = eciesDecrypt(recipientUP.priv, offer.endpointBox);
  return { peerWgPub: offer.wgPub, peerEndpoint: endpoint, verifiedFrom: recovered };
}

// ========================= run the full A<->B handshake =========================
console.log('=== UP-gated ephemeral WireGuard handshake PoC ===\n');

const alice = makeUP('Alice');
const bob = makeUP('Bob');
console.log(`Alice UP: ${alice.address}`);
console.log(`Bob   UP: ${bob.address}\n`);

// Alice -> Bob
const offerAB = await makeOffer(alice, bob, '203.0.113.10:51820');
console.log('Alice builds offer (this payload goes into LSP8 token metadata):');
console.log('  wgPub   :', offerAB.wgPub);
console.log('  path    :', offerAB.path, '(public selector)');
console.log('  endpoint: [ECIES-encrypted, only Bob can read]\n');

const bobView = verifyOffer(offerAB, alice.address, bob);
console.log('Bob verifies Alice offer:');
console.log('  signature -> recovered:', bobView.verifiedFrom, '== Alice ✓');
console.log('  decrypted endpoint    :', bobView.peerEndpoint, '✓\n');

// Bob -> Alice (reply with his side)
const offerBA = await makeOffer(bob, alice, '198.51.100.20:51820');
const aliceView = verifyOffer(offerBA, bob.address, alice);
console.log('Alice verifies Bob reply:');
console.log('  signature -> recovered:', aliceView.verifiedFrom, '== Bob ✓');
console.log('  decrypted endpoint    :', aliceView.peerEndpoint, '✓\n');

// Each side regenerates ITS OWN wg priv from (UP_priv, path, nonce) — determinism check
const aliceWg = deriveWgKeypair(alice.priv, offerAB.path, unhex(offerAB.nonce));
if (hex(aliceWg.wgPub) !== offerAB.wgPub) throw new Error('determinism FAILED: wg key not reproducible');
console.log('Determinism: Alice re-derives same WG pubkey from (UP_priv, path, nonce) ✓');

// Resulting WireGuard config fragments (what you would feed to `wg set`)
console.log('\n--- WireGuard config Alice would raise ---');
console.log(`[Interface] PrivateKey = ${Buffer.from(aliceWg.wgPriv).toString('base64')} (ephemeral)`);
console.log(`[Peer]      PublicKey  = ${Buffer.from(unhex(aliceView.peerWgPub)).toString('base64')}`);
console.log(`            Endpoint   = ${aliceView.peerEndpoint}`);
console.log(`            AllowedIPs = fd00:up::2/128   PersistentKeepalive = 25`);

// ===================== negative tests: MITM / tamper must FAIL =====================
console.log('\n=== adversarial checks (all must be REJECTED) ===');
function mustReject(name, fn) {
  try { fn(); console.log(`  ✗ ${name}: NOT rejected — SECURITY BUG`); process.exitCode = 1; }
  catch (e) { console.log(`  ✓ ${name}: rejected (${e.message.slice(0, 48)}…)`); }
}
// (a) attacker swaps the WG pubkey in transit (classic MITM on the tunnel key)
mustReject('tampered wgPub', () => {
  const t = structuredClone(offerAB); t.wgPub = hex(x25519.getPublicKey(secp256k1.utils.randomPrivateKey()).slice(0,32));
  verifyOffer(t, alice.address, bob);
});
// (b) attacker forges from-address: claims Alice but signs with Mallory's key
const mallory = makeUP('Mallory');
const forged = structuredClone(offerAB); forged.from = alice.address; // claim to be Alice
forged.signature = mallory.wallet.signingKey.sign(ethers.getBytes(canonicalDigest(forged))).serialized;
mustReject('forged from-address', () => verifyOffer(forged, alice.address, bob));
// (c) wrong recipient tries to decrypt the endpoint
mustReject('wrong recipient decrypt', () => verifyOffer(offerAB, alice.address, mallory));
// (d) expired offer — genuinely re-signed by Alice, must still fail on expiry
const expired = structuredClone(offerAB); expired.expiry = 1;
expired.signature = await alice.wallet.signMessage(ethers.getBytes(canonicalDigest(expired)));
mustReject('expired offer', () => verifyOffer(expired, alice.address, bob));

console.log('\n=== PoC complete ===');
