// e2ee.js — X25519 ECDH + AES-256-GCM conversation encryption.
//
// Mirrors the Polkadot Product Devnet's upgrade to X25519 key exchange
// (Sept 9 2026 release notes, via PCF forum). Only the two conversation
// participants can derive the symmetric key; everyone else gets a GCM
// auth-tag failure (demonstrated in devnet-spike.js).
//
// Simplifications vs. a production E2EE implementation (documented in
// docs/ADAPTERS.md):
//   - STATIC keypairs per user (a real app uses an ephemeral key per session
//     for forward secrecy — X3DH / Double Ratchet are the reference designs),
//   - no message replay protection here (that job belongs to the on-chain
//     anchor's per-sender nonce — see MessageAnchor.sol).
'use strict';
const crypto = require('crypto');

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    pub: raw.toString('hex'), // 32-byte raw X25519 public key
    priv: privateKey, // KeyObject (keep in a wallet / LSP6 KeyManager in production)
  };
}

function pubToKeyObject(pubHex) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
}

// Per-conversation symmetric key from the two X25519 identities (static-static
// ECDH, keyed by threadId for domain separation). Deterministic: both sides
// derive the same 32-byte key.
function conversationKey(idA, idB, threadId) {
  const aIsLo = idA.pub <= idB.pub;
  const priv = aIsLo ? idA.priv : idB.priv;
  const pub = aIsLo ? pubToKeyObject(idB.pub) : pubToKeyObject(idA.pub);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const salt = crypto.createHash('sha256').update(threadId, 'utf8').digest();
  return crypto.hkdfSync('sha256', shared, salt, 'up-chat-v1', 32);
}

// encrypt(plaintext, key, threadId) -> envelope { v, threadId, iv, tag, ct } (hex fields)
function encrypt(plaintext, key, threadId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { v: 1, threadId, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}

// decrypt(envelope, key) -> plaintext; throws on tampering / wrong key.
function decrypt(env, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  d.setAuthTag(Buffer.from(env.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'hex')), d.final()]).toString('utf8');
}

module.exports = { makeIdentity, conversationKey, encrypt, decrypt };
