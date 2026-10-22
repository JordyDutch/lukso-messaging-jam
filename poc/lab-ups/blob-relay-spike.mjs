// blob-relay-spike.mjs — SPIKE: decouple blob AUTHOR from Type-3 msg.sender.
//
// Problem: a Type-3 (EIP-4844 blob) tx is an OUTER EOA tx, so msg.sender is
// whoever signs it with a secp256k1 key. The UP Browser Extension (MetaMask-
// based) won't sign Type-3, and a UP can't send Type-3 via LSP0.execute. So the
// user's UP can't be msg.sender of a blob post.
//
// B's idea (validated here): don't treat msg.sender as the author. A RELAYER EOA
// sends the Type-3 tx and pays gas; AUTHORSHIP is proven by an EIP-712 signature
// from the UP's controller over (up, tag, encrypted, threadId, blobHash, nonce).
// The contract (future postBlobFor) recovers that signer and checks it is an
// authorized LSP6 controller of the claimed UP, then binds blobhash(0)==blobHash.
//
// This spike proves the WHOLE path on LUKSO MAINNET without deploying the new
// contract: it performs postBlobFor's on-chain checks OFF-CHAIN against the real
// live UPs (recover authorship signer, read AddressPermissions:Permissions via
// ERC725Y, assert blobHash==versionedHash(blob)), and REALLY sends the Type-3 tx
// from Z (the relayer) to the existing WallV2 so msg.sender (Z) != author (UP).
// The on-chain PostedBlob 'from' will be Z; that's expected — the point is the
// off-chain authorship proof the new contract would enforce.

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
const CL = 'https://rpc.mainnet.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';

// LSP6 AddressPermissions:Permissions:<address> data-key prefix (bytes32 with
// the 20-byte controller address in the low bytes).
const LSP6_PERM_PREFIX = '0x4b80742de2bf82acb3630000';
const ERC725Y = ['function getData(bytes32) view returns (bytes)'];
const WALL_ABI = [
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

// ---- conv-key crypto (byte-identical to frontend2 + dm-proof + blob-flows) -
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

// ---- EIP-712 authorship signature over the post intent --------------------
// This is what the UP controller signs via the extension (same capability we
// already use for conv-key derivation — a plain message sign; here typed data).
// chainId binds to LUKSO; verifyingContract = the future postBlobFor contract.
const AUTH_DOMAIN = (verifyingContract) => ({
  name: 'UP Dawg blob authorship', version: '1', chainId: 42, verifyingContract,
});
const AUTH_TYPES = {
  BlobPost: [
    { name: 'up', type: 'address' },
    { name: 'tag', type: 'address' },
    { name: 'encrypted', type: 'bool' },
    { name: 'threadId', type: 'bytes32' },
    { name: 'blobHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};
async function signAuthorship(controllerWallet, verifyingContract, msg) {
  return controllerWallet.signTypedData(AUTH_DOMAIN(verifyingContract), AUTH_TYPES, msg);
}
function recoverAuthor(verifyingContract, msg, sig) {
  return ethers.verifyTypedData(AUTH_DOMAIN(verifyingContract), AUTH_TYPES, msg, sig);
}

// ---- the off-chain mirror of what postBlobFor would enforce ON-CHAIN ------
// 1) recover authorship signer from the EIP-712 sig
// 2) read AddressPermissions:Permissions:<signer> on the claimed UP (ERC725Y);
//    non-zero => authorized controller.
// 3) (on-chain the EVM also asserts blobhash(0)==blobHash; we assert the
//    versioned hash of the actual blob we attach equals the signed blobHash.)
async function verifyPostBlobFor(provider, verifyingContract, { up, msg, sig, attachedBlobHash }) {
  // The signer is the UP's CONTROLLER (an EOA key held by the extension), NOT
  // the UP address itself. Authorship = "this signer is an authorized LSP6
  // controller of the claimed UP", proven by the ERC725Y permission read below.
  const signer = recoverAuthor(verifyingContract, msg, sig);
  if (ethers.getAddress(msg.up) !== ethers.getAddress(up))
    throw new Error(`signed up-field ${msg.up} != claimed up ${up}`);
  const y = new ethers.Contract(up, ERC725Y, provider);
  const permKey = LSP6_PERM_PREFIX + signer.slice(2).toLowerCase();
  const perm = await y.getData(permKey);
  const authorized = perm && perm !== '0x' && BigInt(perm) !== 0n;
  if (!authorized) throw new Error(`signer ${signer} is NOT an LSP6 controller of ${up} (perm=${perm})`);
  if (attachedBlobHash.toLowerCase() !== msg.blobHash.toLowerCase())
    throw new Error('attached blob versioned hash != signed blobHash');
  return { signer, perm };
}

// ---- send the Type-3 tx FROM THE RELAYER (msg.sender = relayer, not author) -
async function relaySendBlob(relayer, iface, kzg, { tag, encrypted, threadId, blobHash, body, authorUp }) {
  const blob = encodeBlob(body);
  const blobHex = '0x' + Buffer.from(blob).toString('hex');
  // meta now also carries the author UP + the authorship sig so readers/contract
  // can see who the post is really from. (Stays within WallV2 MAX_META=256? sig
  // is 65B + addr 20B => ~85B hex-encoded fits; here we keep meta small and only
  // record authorUp — the full sig would live in calldata of postBlobFor.)
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length, by: authorUp }));
  const data = iface.encodeFunctionData('postBlob', [tag, encrypted, threadId, blobHash, meta]);
  const fee = await relayer.provider.getFeeData();
  const tx = await relayer.sendTransaction({
    type: 3, to: WALLV2, data, chainId: 42,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
    gasLimit: 300000n, blobs: [blobHex], kzg,
  });
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((p) => p.name === 'PostedBlob');
  return { txHash: tx.hash, block: rcpt.blockNumber, onchainFrom: ev.args.from, id: ev.args.id.toString() };
}

function versionedHashOfBlob(kzg, blobHex) {
  const probe = ethers.Transaction.from({
    type: 3, to: WALLV2, chainId: 42, nonce: 0,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n, gasLimit: 21000n,
    data: '0x', blobs: [blobHex], kzg,
  });
  return probe.blobVersionedHashes[0];
}

async function main() {
  console.log('=== SPIKE: blob relay-authorship (author != msg.sender) — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, 42, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== 42n) throw new Error('wrong chain');
  const reader = new ethers.JsonRpcProvider(EL, 42, { staticNetwork: true }); // fresh 3rd-party reader
  const kzg = await loadKZG();
  const iface = new ethers.Interface(WALL_ABI);

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(path.join(__dirname, 'state.json'));
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey); // UP controller
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey);
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const bobUp = ethers.getAddress(st.bob.upAddress);
  // Pretend verifyingContract = a deployed postBlobFor. Address is irrelevant to
  // the spike's logic (EIP-712 just binds it); use WallV2's address as a stand-in.
  const VERIFYING = WALLV2;

  console.log('relayer EOA (msg.sender):', relayer.address,
    ethers.formatEther(await provider.getBalance(relayer.address)), 'LYX');
  console.log('alice UP (author):', aliceUp, ' controller:', aliceCtrl.address);
  console.log('bob   UP (author):', bobUp, ' controller:', bobCtrl.address);
  console.log('');

  const out = { network: 'lukso-mainnet', wall: WALLV2, verifyingContract: VERIFYING, flows: {} };

  // ---- FLOW A: relayed PUBLIC post, author = alice UP, sender = relayer -----
  {
    console.log('--- FLOW A: relayed public blob post (author=alice UP, not msg.sender) ---');
    const body = enc.encode(`relayed public post from alice UP — ${new Date().toISOString()}`);
    const blobHex = '0x' + Buffer.from(encodeBlob(body)).toString('hex');
    const blobHash = versionedHashOfBlob(kzg, blobHex);
    const tag = ethers.ZeroAddress, encrypted = false, threadId = ethers.ZeroHash;
    const nonce = 0n; // in prod: per-UP nonce from the contract
    const msg = { up: aliceUp, tag, encrypted, threadId, blobHash, nonce };

    // 1) UP controller signs authorship (the extension CAN do this today).
    const sig = await signAuthorship(aliceCtrl, VERIFYING, msg);
    console.log('authorship sig by alice controller:', sig.slice(0, 20) + '…');

    // 2) off-chain mirror of postBlobFor's checks (recover + LSP6 + blobHash).
    const chk = await verifyPostBlobFor(provider, VERIFYING, { up: aliceUp, msg, sig, attachedBlobHash: blobHash });
    console.log('✓ postBlobFor checks pass: author', chk.signer, 'is LSP6 controller perm', chk.perm);

    // 3) relayer sends the REAL Type-3 tx (msg.sender = relayer).
    const sent = await relaySendBlob(relayer, iface, kzg, { tag, encrypted, threadId, blobHash, body, authorUp: aliceUp });
    console.log('Type-3 tx:', sent.txHash, 'block', sent.block, 'PostedBlob id', sent.id);
    console.log('on-chain msg.sender (PostedBlob.from):', sent.onchainFrom,
      '→ != author UP', aliceUp, '=>', ethers.getAddress(sent.onchainFrom) !== aliceUp);

    // 4) 3rd-party reader recovers body from the beacon and matches the hash.
    const got = await fetchBlobBody(reader, sent.txHash, blobHash);
    const recovered = dec.decode(got);
    const okBody = recovered === dec.decode(body);
    console.log('recovered from beacon:', JSON.stringify(recovered), 'match:', okBody);
    if (!okBody) throw new Error('FLOW A body mismatch');

    out.flows.publicRelayed = {
      txHash: sent.txHash, id: sent.id, blobHash,
      author: aliceUp, msgSender: sent.onchainFrom,
      authorNotSender: ethers.getAddress(sent.onchainFrom) !== aliceUp,
      authorshipRecovered: chk.signer, lsp6Perm: chk.perm, bodyRecovered: okBody,
    };
  }

  // ---- FLOW B: relayed ENCRYPTED DM alice -> bob over the blob lane ---------
  {
    console.log('\n--- FLOW B: relayed encrypted DM alice→bob (author=alice UP, sealed body) ---');
    const alice = await deriveConvKey(aliceCtrl);
    const bob = await deriveConvKey(bobCtrl);
    const tid = threadIdFor(aliceUp, bobUp);
    const dmText = `relayed sealed DM alice→bob — ${new Date().toISOString()}`;
    const key = conversationKey(alice.priv, bob.pub, tid);
    const sealed = await sealBytes(enc.encode(dmText), key);
    const blobHex = '0x' + Buffer.from(encodeBlob(sealed)).toString('hex');
    const blobHash = versionedHashOfBlob(kzg, blobHex);
    const tag = bobUp, encrypted = true, threadId = tid, nonce = 1n;
    const msg = { up: aliceUp, tag, encrypted, threadId, blobHash, nonce };

    const sig = await signAuthorship(aliceCtrl, VERIFYING, msg);
    const chk = await verifyPostBlobFor(provider, VERIFYING, { up: aliceUp, msg, sig, attachedBlobHash: blobHash });
    console.log('✓ postBlobFor checks pass: author', chk.signer, 'LSP6 controller of alice UP');

    const sent = await relaySendBlob(relayer, iface, kzg, { tag, encrypted, threadId, blobHash, body: sealed, authorUp: aliceUp });
    console.log('Type-3 tx:', sent.txHash, 'block', sent.block, 'PostedBlob id', sent.id);
    console.log('on-chain msg.sender:', sent.onchainFrom, '!= author UP', aliceUp, '=>',
      ethers.getAddress(sent.onchainFrom) !== aliceUp);

    // bob recovers from beacon and decrypts with the shared conv key.
    const got = await fetchBlobBody(reader, sent.txHash, blobHash);
    const bobKey = conversationKey(bob.priv, alice.pub, tid);
    const opened = dec.decode(await openBytes(got, bobKey));
    const okDm = opened === dmText;
    console.log('bob decrypted:', JSON.stringify(opened), 'match:', okDm);
    if (!okDm) throw new Error('FLOW B DM mismatch');

    out.flows.dmRelayed = {
      txHash: sent.txHash, id: sent.id, blobHash, threadId: tid,
      author: aliceUp, peer: bobUp, msgSender: sent.onchainFrom,
      authorNotSender: ethers.getAddress(sent.onchainFrom) !== aliceUp,
      authorshipRecovered: chk.signer, lsp6Perm: chk.perm, dmDecrypted: okDm,
    };
  }

  // ---- NEGATIVE: a forged authorship (wrong signer) must FAIL the check -----
  {
    console.log('\n--- NEGATIVE: non-controller signs authorship for alice UP (must reject) ---');
    const body = enc.encode('forged');
    const blobHex = '0x' + Buffer.from(encodeBlob(body)).toString('hex');
    const blobHash = versionedHashOfBlob(kzg, blobHex);
    const msg = { up: aliceUp, tag: ethers.ZeroAddress, encrypted: false, threadId: ethers.ZeroHash, blobHash, nonce: 99n };
    // bob's controller signs claiming to be alice UP's author
    const sig = await signAuthorship(bobCtrl, VERIFYING, { ...msg });
    let rejected = false, why = '';
    try { await verifyPostBlobFor(provider, VERIFYING, { up: aliceUp, msg, sig, attachedBlobHash: blobHash }); }
    catch (e) { rejected = true; why = e.message; }
    console.log('forged authorship rejected:', rejected, '—', why);
    if (!rejected) throw new Error('NEGATIVE failed: forged authorship was accepted!');
    out.flows.negativeForgedRejected = { rejected, why };
  }

  out.verdict = 'PASS';
  fs.writeFileSync(path.join(__dirname, 'blob-relay-spike-result.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ RELAY-AUTHORSHIP SPIKE PASS. wrote blob-relay-spike-result.json');
}

main().catch((e) => { console.error('\n❌ SPIKE FAILED:', e); process.exit(1); });
