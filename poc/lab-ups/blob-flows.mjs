// blob-flows.mjs — headless end-to-end test of the KNOWN UP Dawg flows over the
// EIP-4844 BLOB lane on LUKSO mainnet (WallV2.postBlob).
//
// Mirrors the frontend blob senders (frontend2/src/lib/wall.ts + blob.ts) and
// the beacon-backed reader, proving the whole blob-only path works:
//
//   FLOW 1  public blob post : body in a blob, hash anchored, recovered by a
//                              THIRD-PARTY reader from the beacon sidecar, UTF-8
//                              decoded == original.
//   FLOW 2  encrypted blob DM: body sealed to the (sender,peer) X25519 conv key,
//                              shipped in a blob, recovered from the beacon and
//                              DECRYPTED by the peer == original plaintext.
//
// Blob txs are Type-3 and must originate from a wallet that signs Type-3 — a UP
// can't send one via UP.execute (the blob rides the OUTER tx). So, exactly like
// the frontend's signer path, posts here are sent from a raw EOA; the conv-key
// crypto is byte-identical to the browser. This proves write+read+crypto for the
// blob lane; whether the UP extension can sign Type-3 is the separate open
// question the UI now probes.
//
// Run from poc/: node lab-ups/blob-flows.mjs
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const { loadKZG } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/kzg-wasm');

const EL = 'https://rpc.mainnet.lukso.network';
const CL = 'https://rpc.mainnet.lukso.network'; // same host answers the beacon API
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';

const ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];
const enc = new TextEncoder();
const dec = new TextDecoder();
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---- blob codec (byte-identical to frontend2/src/lib/blob.ts) -------------
const FIELD_ELEMENTS = 4096;
const BLOB_SIZE = FIELD_ELEMENTS * 32;
function encodeBlob(payload) {
  const blob = new Uint8Array(BLOB_SIZE);
  const len = payload.length;
  blob[28] = (len >>> 24) & 0xff; blob[29] = (len >>> 16) & 0xff;
  blob[30] = (len >>> 8) & 0xff; blob[31] = len & 0xff;
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1;
    for (let i = 0; i < 31 && o < len; i++) blob[base + i] = payload[o++];
  }
  return blob;
}
function decodeBlob(blob) {
  const len = (blob[28] << 24) | (blob[29] << 16) | (blob[30] << 8) | blob[31];
  const out = new Uint8Array(len); let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1;
    for (let i = 0; i < 31 && o < len; i++) out[o++] = blob[base + i];
  }
  return out;
}

// ---- conv-key crypto (byte-identical to frontend2/src/lib + dm-proof.mjs) --
async function deriveConvKey(wallet) {
  const sig = await wallet.signMessage(CONV_KEY_DOMAIN);
  const ikm = ethers.getBytes(sig);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const priv = hkdf(sha256, ikm, salt, enc.encode('x25519-conv-v1'), 32);
  return { priv, pub: x25519.getPublicKey(priv) };
}
function threadIdFor(a, b) {
  const [lo, hi] = [a, b].map((x) => ethers.getAddress(x)).sort();
  return ethers.keccak256(ethers.concat([ethers.zeroPadValue(lo, 32), ethers.zeroPadValue(hi, 32)]));
}
function conversationKey(myPriv, peerPub, threadId) {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = ethers.getBytes(ethers.keccak256(ethers.getBytes(threadId)));
  return hkdf(sha256, shared, salt, enc.encode('up-chat-v1'), 32);
}
const MAGIC = Uint8Array.from([0x45, 0xe2]);
function concatB(...a) { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; }
async function sealBytes(buf, key) {
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, buf));
  const ct = sealed.subarray(0, sealed.length - 16), tag = sealed.subarray(sealed.length - 16);
  return concatB(MAGIC, iv, tag, ct);
}
async function openBytes(body, key) {
  const iv = body.subarray(2, 14), tag = body.subarray(14, 30), ct = body.subarray(30);
  const ck = await crypto.webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, concatB(ct, tag));
  return new Uint8Array(plain);
}

// ---- beacon retrieval (byte-identical logic to frontend2/src/lib/blob.ts) -
let genesis = null;
async function beaconGenesis() {
  if (genesis == null) genesis = Number((await (await fetch(CL + '/eth/v1/beacon/genesis')).json()).data.genesis_time);
  return genesis;
}
function vhOfCommitment(commitHex) {
  const commit = Buffer.from(commitHex.slice(2), 'hex');
  const h = crypto.createHash('sha256').update(commit).digest();
  h[0] = 0x01;
  return '0x' + h.toString('hex');
}
async function fetchBlobBody(provider, txHash, anchoredHash) {
  const rcpt = await provider.getTransactionReceipt(txHash);
  const blk = await provider.getBlock(rcpt.blockNumber);
  const slot = Math.floor((Number(blk.timestamp) - (await beaconGenesis())) / 12);
  const res = await fetch(CL + `/eth/v1/beacon/blob_sidecars/${slot}`);
  if (!res.ok) throw new Error('sidecars ' + res.status);
  const scs = (await res.json()).data ?? [];
  for (const sc of scs) {
    if (vhOfCommitment(sc.kzg_commitment).toLowerCase() === anchoredHash.toLowerCase()) {
      return decodeBlob(Buffer.from(sc.blob.slice(2), 'hex'));
    }
  }
  throw new Error('no sidecar matched anchored hash (pruned or mismatch)');
}

// ---- send a Type-3 postBlob (mirrors frontend2 sendBlobPost) --------------
async function sendBlobPost(signer, iface, kzg, { tag, encrypted, threadId, body }) {
  const blob = encodeBlob(body);
  const blobHex = '0x' + Buffer.from(blob).toString('hex');
  const probe = ethers.Transaction.from({
    type: 3, to: WALLV2, chainId: 42, nonce: 0,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n, gasLimit: 21000n,
    data: '0x', blobs: [blobHex], kzg,
  });
  const blobHash = probe.blobVersionedHashes[0];
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length }));
  const data = iface.encodeFunctionData('postBlob', [tag, encrypted, threadId, blobHash, meta]);
  const fee = await signer.provider.getFeeData();
  const tx = await signer.sendTransaction({
    type: 3, to: WALLV2, data, chainId: 42,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
    gasLimit: 250000n, blobs: [blobHex], kzg,
  });
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((p) => p.name === 'PostedBlob');
  return { txHash: tx.hash, block: rcpt.blockNumber, blobHash, id: ev.args.id.toString() };
}

async function main() {
  console.log('=== UP Dawg blob-lane flows — LUKSO MAINNET — WallV2 ===\n');
  const provider = new ethers.JsonRpcProvider(EL, 42, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== 42n) throw new Error('wrong chain');
  const z = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  console.log('sender EOA:', z.address, ethers.formatEther(await provider.getBalance(z.address)), 'LYX');
  const kzg = await loadKZG();
  const iface = new ethers.Interface(ABI);
  // a fresh read-only provider = the "third-party reader" (no tx knowledge)
  const reader = new ethers.JsonRpcProvider(EL, 42, { staticNetwork: true });

  // ---- FLOW 1: public blob post ----
  console.log('\n--- FLOW 1: public blob post ---');
  const pubText = `UP Dawg PUBLIC via blob @ ${new Date().toISOString()} 🌭🫧`;
  const r1 = await sendBlobPost(z, iface, kzg, {
    tag: ethers.ZeroAddress, encrypted: false, threadId: ethers.ZeroHash, body: enc.encode(pubText),
  });
  console.log('posted id', r1.id, 'tx', EXPLORER + '/tx/' + r1.txHash, 'block', r1.block);
  const got1 = await fetchBlobBody(reader, r1.txHash, r1.blobHash);
  const dec1 = dec.decode(got1);
  console.log('reader recovered:', JSON.stringify(dec1));
  if (dec1 !== pubText) throw new Error('FLOW 1 FAIL: public body mismatch');
  console.log('✅ FLOW 1 PASS: public blob body recovered from beacon by a third party, UTF-8 matches.');

  // ---- FLOW 2: encrypted blob DM alice -> bob ----
  console.log('\n--- FLOW 2: encrypted blob DM (sealed to conv key) ---');
  const st = load(path.join(__dirname, 'state.json'));
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey);
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey);
  const alice = await deriveConvKey(aliceCtrl);
  const bob = await deriveConvKey(bobCtrl);
  const aAddr = st.alice.upAddress, bAddr = st.bob.upAddress;
  const tid = threadIdFor(aAddr, bAddr);
  const dmText = `secret DM alice→bob via blob @ ${new Date().toISOString()} — only bob can open this 🔒`;
  // alice seals to the shared key, ships in a blob tagged to bob
  const key = conversationKey(alice.priv, bob.pub, tid);
  const sealed = await sealBytes(enc.encode(dmText), key);
  const r2 = await sendBlobPost(z, iface, kzg, {
    tag: bAddr, encrypted: true, threadId: tid, body: sealed,
  });
  console.log('posted id', r2.id, 'tx', EXPLORER + '/tx/' + r2.txHash, 'block', r2.block);
  // bob (reader) recovers the sealed body from the beacon and decrypts
  const got2 = await fetchBlobBody(reader, r2.txHash, r2.blobHash);
  const bobKey = conversationKey(bob.priv, alice.pub, tid);
  const opened = dec.decode(await openBytes(got2, bobKey));
  console.log('bob decrypted:', JSON.stringify(opened));
  if (opened !== dmText) throw new Error('FLOW 2 FAIL: decrypted DM mismatch');
  console.log('✅ FLOW 2 PASS: encrypted DM rode a blob, recovered from beacon, decrypted by bob.');

  const out = {
    ok: true, when: new Date().toISOString(),
    flow1: { id: r1.id, txHash: r1.txHash, block: r1.block, blobHash: r1.blobHash },
    flow2: { id: r2.id, txHash: r2.txHash, block: r2.block, blobHash: r2.blobHash, threadId: tid },
  };
  fs.writeFileSync(path.join(__dirname, 'blob-flows-result.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ ALL BLOB FLOWS PASS. wrote blob-flows-result.json');
}
main().catch((e) => { console.error('\n❌ BLOB FLOWS FAIL:', e?.shortMessage || e?.message || e); process.exit(1); });
