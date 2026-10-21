// lab-crypto.mjs — shared crypto for the E2E lab.
//
// Each test "UP" = { ctrl: secp256k1 controller (identity+signing+gas),
//                    conv: X25519 conversation keypair (ECDH for decryption) }.
//
// The crucial fix vs. the earlier board/lobby scripts: the conversation key is
// a REAL static-static X25519 ECDH between the two parties' conv keys, so the
// RECIPIENT can derive the same key and actually DECRYPT — not a sender-only
// HKDF. Authenticity still comes from the secp256k1 EIP-191 signature inside.

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { ethers } from 'ethers';

export const HKDF_INFO = 'wg-x25519-v1';
export const enc = new TextEncoder();
export const hx = (u8) => '0x' + Buffer.from(u8).toString('hex');
export const ub = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

// Derive the ephemeral WireGuard X25519 key from the controller secp256k1 priv.
export function deriveWg(ctrlPriv, path, nonce) {
  const info = new Uint8Array([...enc.encode(HKDF_INFO + '|' + path), ...nonce]);
  const wgPriv = hkdf(sha256, ctrlPriv, nonce, info, 32);
  return { wgPriv, wgPub: x25519.getPublicKey(wgPriv) };
}

// Real shared conversation key: static-static X25519 ECDH, order-independent,
// domain-separated by threadId. BOTH sides compute the identical 32 bytes.
export function conversationKey(myConvPriv, peerConvPub, threadId) {
  const shared = x25519.getSharedSecret(myConvPriv, peerConvPub); // 32B
  const salt = ethers.getBytes(ethers.keccak256(ethers.getBytes(threadId)));
  return hkdf(sha256, shared, salt, enc.encode('up-chat-v1'), 32);
}

export function threadIdFor(aAddr, bAddr) {
  const [lo, hi] = [aAddr, bAddr].map((a) => ethers.getAddress(a)).sort();
  return ethers.keccak256(ethers.concat([
    ethers.zeroPadValue(lo, 32), ethers.zeroPadValue(hi, 32),
  ]));
}

export function sealBytes(buf, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('45e2', 'hex'), iv, c.getAuthTag(), ct]);
}
export function openBytes(body, key) {
  const iv = body.subarray(2, 14), tag = body.subarray(14, 30), ct = body.subarray(30);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// Build a signed+sealed WG offer body (<=200 B) FROM sender TO recipient, using
// the real shared conversation key so the recipient can open it.
export async function buildOffer({ fromCtrlWallet, fromCtrlPriv, fromConvPriv,
                                   toConvPub, toAddr, endpoint }) {
  const path = `m/wg/${Math.floor(Math.random() * 1000)}`;
  const nonce = randomBytes(12);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const { wgPub, wgPriv } = deriveWg(fromCtrlPriv, path, nonce);

  const core = Buffer.concat([
    Buffer.from(ethers.getBytes(wgPub)),                                          // 32
    Buffer.from(nonce),                                                           // 12
    Buffer.from(ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(expiry), 5))),// 5
    enc.encode(endpoint),                                                         // var
  ]);
  const sig = await fromCtrlWallet.signMessage(ethers.getBytes(ethers.keccak256(core))); // 65
  const payload = Buffer.concat([core, Buffer.from(ethers.getBytes(sig))]);

  const threadId = threadIdFor(fromCtrlWallet.address, toAddr);
  const key = conversationKey(fromConvPriv, toConvPub, threadId);
  const body = sealBytes(payload, Buffer.from(key));
  return { body, path, nonce, expiry, wgPub: hx(wgPub), wgPriv, threadId };
}

// Recipient: open + verify + extract. Returns derived peer WG pub + endpoint.
export function openOffer({ body, myConvPriv, fromConvPub, fromAddr, toAddr, expectFrom }) {
  const threadId = threadIdFor(fromAddr, toAddr);
  const key = conversationKey(myConvPriv, fromConvPub, threadId);
  const payload = openBytes(body, Buffer.from(key)); // throws on tamper/wrong key
  const sig = hx(payload.subarray(payload.length - 65));
  const core = payload.subarray(0, payload.length - 65);
  const recovered = ethers.verifyMessage(ethers.getBytes(ethers.keccak256(core)), sig);
  if (recovered.toLowerCase() !== ethers.getAddress(expectFrom).toLowerCase())
    throw new Error(`signature mismatch (MITM?) recovered=${recovered}`);
  const peerWgPub = hx(core.subarray(0, 32));
  const expiry = Number('0x' + Buffer.from(core.subarray(44, 49)).toString('hex'));
  if (expiry < Math.floor(Date.now() / 1000)) throw new Error('offer expired');
  const endpoint = Buffer.from(core.subarray(49)).toString('utf8');
  return { peerWgPub, endpoint, verifiedFrom: recovered, expiry };
}

export { secp256k1, x25519, ethers };
