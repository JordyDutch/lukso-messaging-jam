'use strict';
// gen-e2ee.js — generate X25519 keypairs for the LUKSO DM experiment,
// build the E2EE envelope for post #2, verify roundtrip on the RECIPIENT side.
const crypto = require('crypto');
const fs = require('fs');
const { ethers } = require('ethers');
const e2ee = require('../devnet-adapter/e2ee');

const z = e2ee.makeIdentity();
const blaise8 = e2ee.makeIdentity();

// threadId = keccak256(zeroPad(sortedA) ++ zeroPad(sortedB)) per the PoC design
const A = '0x80b890cd922925d0d74c99c9fac3f17a66640135'; // Z EOA (sender)
const B = '0xa857e696bd0f689c2120061e3a61e8e0103c2d79'; // blaise8 UP
const [lo, hi] = [A, B].sort();
const threadId = ethers.keccak256(ethers.concat([
  ethers.zeroPadValue(ethers.getAddress(lo), 32),
  ethers.zeroPadValue(ethers.getAddress(hi), 32),
]));

const keyZ = e2ee.conversationKey(z, blaise8, threadId);
const plain = "E2EE #2: only blaise8 can read this. Key = X25519 ECDH + HKDF over threadId. Repo: m8b/lukso-jam-messaging. 2026-10-21 CEST - Z";
const env = e2ee.encrypt(plain, keyZ, threadId);

// binary envelope: magic 0x45E2 + iv(12) + tag(16) + ct
const envBytes = Buffer.concat([
  Buffer.from('45e2', 'hex'),
  Buffer.from(env.iv, 'hex'),
  Buffer.from(env.tag, 'hex'),
  Buffer.from(env.ct, 'hex'),
]);
console.log('envelope bytes:', envBytes.length, '(board limit 200)');
if (envBytes.length > 200) { console.error('TOO LONG'); process.exit(1); }

// verify on the RECIPIENT side (order must not matter)
const keyB = e2ee.conversationKey(blaise8, z, threadId);
if (!Buffer.compare(Buffer.from(keyZ), Buffer.from(keyB))) { console.error('KEY MISMATCH (order-dependent)'); process.exit(1); }
const dec = e2ee.decrypt(env, keyB);
console.log('roundtrip with blaise8-side key:', dec === plain ? 'OK' : 'FAIL');
// negative control: a stranger key must fail
const stranger = e2ee.makeIdentity();
const keyStranger = e2ee.conversationKey(stranger, blaise8, threadId);
let neg = 'n/a';
try { e2ee.decrypt(env, keyStranger); neg = 'DECRYPTED (BAD!)'; } catch { neg = 'rejected (GCM auth fail) — OK'; }
console.log('stranger key:', neg);

fs.writeFileSync('/home/bk/.openclaw/workspace/.z-x25519.json', JSON.stringify({
  note: 'Z (agent) X25519 identity for the LUKSO DM experiment. PRIVATE. gitignored.',
  pub: z.pub,
  priv: z.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  threadId,
}, null, 2));
fs.writeFileSync('/tmp/blaise8-key.json', JSON.stringify({
  note: 'blaise8 X25519 identity (B holds the private key)',
  pub: blaise8.pub,
  priv: blaise8.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  threadId,
  plain,
}, null, 2));
fs.writeFileSync('/tmp/env-hex.txt', envBytes.toString('hex'));
console.log('zPub       :', z.pub);
console.log('blaise8Pub :', blaise8.pub);
console.log('blaise8Priv:', blaise8.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex'));
console.log('threadId   :', threadId);
console.log('envHex     :', envBytes.toString('hex'));
