// crypto.ts — layers 1-3 ported 1:1 from poc/up-wg-handshake/e2e-lab/lab-crypto.mjs
// to the browser. The ONLY substantive changes vs. the lab:
//   - node:crypto AES-256-GCM  ->  WebCrypto (SubtleCrypto), so seal/open are async.
//   - added the `webrtc-dtls-v1` HKDF branch for a deterministic WebRTC DTLS key
//     (FRONTEND-PLAN.md "Derivation path — survives, just changes `info`").
//
// Domain separation is preserved exactly: WG uses info "wg-x25519-v1", WebRTC
// uses "webrtc-dtls-v1", so a key derived for one protocol can never collide
// with the other from the same seed.

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { ethers } from 'ethers';

// ---- domain-separation tags (the hard no-cross-protocol-reuse rule) ----
export const HKDF_INFO_WG = 'wg-x25519-v1';
export const HKDF_INFO_WEBRTC = 'webrtc-dtls-v1';

export const enc = new TextEncoder();
const dec = new TextDecoder();

export const hx = (u8: Uint8Array): string => '0x' + bytesToHex(u8);
export const ub = (h: string): Uint8Array => hexToBytes(h.replace(/^0x/, ''));

function bytesToHex(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(h: string): Uint8Array {
  const clean = h.length % 2 ? '0' + h : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Return a standalone ArrayBuffer holding exactly these bytes. WebCrypto and
 * fetch type their inputs as ArrayBuffer-backed (TS 5.7+ distinguishes
 * ArrayBuffer from SharedArrayBuffer); @noble returns Uint8Array over
 * ArrayBufferLike, so we copy into a fresh ArrayBuffer at those boundaries.
 */
export function toBuf(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.length);
  new Uint8Array(out).set(u8);
  return out;
}

// ---------------------------------------------------------------------------
// Layer: derivation path. Deterministic ephemeral keys from the UP controller
// priv, zero stored state. 1:1 with lab `deriveWg`, generalized over `info`.
// ---------------------------------------------------------------------------

/** WireGuard X25519 ephemeral key (kept for parity / future full-VPN mode). */
export function deriveWg(
  ctrlPriv: Uint8Array,
  path: string,
  nonce: Uint8Array,
): { wgPriv: Uint8Array; wgPub: Uint8Array } {
  const info = concatBytes(enc.encode(HKDF_INFO_WG + '|' + path), nonce);
  const wgPriv = hkdf(sha256, ctrlPriv, nonce, info, 32);
  return { wgPriv, wgPub: x25519.getPublicKey(wgPriv) };
}

/**
 * WebRTC DTLS keypair, deterministically derived from the UP controller priv.
 * Same mechanism as deriveWg, different `info` (domain separation) so the
 * WebRTC key never collides with a WG key from the same seed.
 *
 * Returns a raw 32-byte seed suitable for building an ECDSA P-256 keypair for
 * the DTLS certificate (see webrtc.ts), plus the derived secp256k1-style scalar
 * so callers can also expose a stable fingerprint-signing material if desired.
 */
export function deriveDtlsSeed(
  ctrlPriv: Uint8Array,
  path: string,
  nonce: Uint8Array,
): Uint8Array {
  const info = concatBytes(enc.encode(HKDF_INFO_WEBRTC + '|' + path), nonce);
  return hkdf(sha256, ctrlPriv, nonce, info, 32);
}

// ---------------------------------------------------------------------------
// Layer: secret exchange. Real static-static X25519 ECDH conversation key,
// order-independent, domain-separated by threadId. 1:1 with the lab.
// ---------------------------------------------------------------------------

export function conversationKey(
  myConvPriv: Uint8Array,
  peerConvPub: Uint8Array,
  threadId: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(myConvPriv, peerConvPub); // 32B
  const salt = ethers.getBytes(ethers.keccak256(ethers.getBytes(threadId)));
  return hkdf(sha256, shared, salt, enc.encode('up-chat-v1'), 32);
}

export function threadIdFor(aAddr: string, bAddr: string): string {
  const [lo, hi] = [aAddr, bAddr].map((a) => ethers.getAddress(a)).sort();
  return ethers.keccak256(
    ethers.concat([ethers.zeroPadValue(lo, 32), ethers.zeroPadValue(hi, 32)]),
  );
}

// ---------------------------------------------------------------------------
// Layer: seal/open — AES-256-GCM. Wire format identical to the lab:
//   magic(2) || iv(12) || tag(16) || ciphertext
// WebCrypto appends the tag to the ciphertext, so we split it back out to keep
// byte-compatibility with the Node lab + Solidity-side expectations.
// ---------------------------------------------------------------------------

const MAGIC = Uint8Array.from([0x45, 0xe2]); // '45e2'

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuf(key), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealBytes(buf: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ck = await importAesKey(key);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(iv), tagLength: 128 }, ck, toBuf(buf)),
  );
  // WebCrypto returns ciphertext||tag; the lab stores iv||tag||ciphertext.
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return concatBytes(MAGIC, iv, tag, ct);
}

export async function openBytes(body: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const iv = body.subarray(2, 14);
  const tag = body.subarray(14, 30);
  const ct = body.subarray(30);
  const ck = await importAesKey(key);
  // Recombine to WebCrypto's expected ciphertext||tag layout.
  const combined = concatBytes(ct, tag);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuf(iv), tagLength: 128 },
    ck,
    toBuf(combined),
  );
  return new Uint8Array(plain);
}

// ---------------------------------------------------------------------------
// Identity: EIP-191 sign/verify over a keccak digest. We sign with an ethers
// signer (the UP controller via the provider) so the private key never leaves
// the extension.
// ---------------------------------------------------------------------------

export interface SignLike {
  signMessage(message: string | Uint8Array): Promise<string>;
  getAddress(): Promise<string>;
}

export { secp256k1, x25519, ethers, bytesToHex, hexToBytes, concatBytes, randomBytes, dec };
