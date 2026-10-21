// dm-proof.mjs — headless end-to-end proof of the UP Wall DM path against the
// LIVE contracts (Wall + RegistryV3) on LUKSO mainnet.
//
// Reproduces, from scripts, exactly the browser flow:
//   1. alice UP  announce(convPub_alice)   via UP.execute -> RegistryV3
//   2. bob   UP  announce(convPub_bob)     via UP.execute -> RegistryV3
//   3. alice UP  encrypted Wall.post(to=bob, encrypted=true, threadId, sealedBody)
//   4. read Wall back, decrypt as bob, assert plaintext matches
//
// conv-key derivation is byte-identical to frontend2/src/lib/up.ts deriveConvKey:
// sign CONV_KEY_DOMAIN (EIP-191) with the controller wallet, HKDF the signature.
// (In the browser the UP signs; here the controller signs. The proof is
// self-consistent either way — it proves the CONTRACT wiring, not the extension
// signature bytes, which is the one thing only the real extension can confirm.)
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALL = '0xd3a767c7fE981524810aF7bdE05FA6537B96f58E';
const REGISTRY = '0x01AC2FE086C2D69923F199d47C85688aB2FA088c';
const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';

const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const REG_ABI = ['function announce(bytes32 convPub) external', 'function convPubOf(address) view returns (bytes32)'];
const WALL_ABI = [
  'function post(address tag, bool encrypted, bytes32 threadId, bytes body)',
  'function count() view returns (uint256)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
];

const enc = new TextEncoder();
const dec = new TextDecoder();
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const link = (k, id) => `${EXPLORER}/${k}/${id}`;

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      if ((await p.getNetwork()).chainId !== 42n) throw new Error('wrong chain');
      return p;
    } catch (e) { err = e; }
  }
  throw err;
}
async function feeOf(p) {
  const f = await p.getFeeData();
  return (f.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n;
}

// --- crypto, 1:1 with frontend2/src/lib ---
async function deriveConv(wallet) {
  const sig = await wallet.signMessage(CONV_KEY_DOMAIN);
  const ikm = ethers.getBytes(sig);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const convPriv = hkdf(sha256, ikm, salt, enc.encode('x25519-conv-v1'), 32);
  return { convPriv, convPub: x25519.getPublicKey(convPriv) };
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
async function seal(buf, key) {
  const { webcrypto } = await import('node:crypto');
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, buf));
  const ct = sealed.subarray(0, sealed.length - 16), tag = sealed.subarray(sealed.length - 16);
  return concatB(MAGIC, iv, tag, ct);
}
async function open(body, key) {
  const { webcrypto } = await import('node:crypto');
  const iv = body.subarray(2, 14), tag = body.subarray(14, 30), ct = body.subarray(30);
  const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, concatB(ct, tag));
  return new Uint8Array(plain);
}

// --- UP action: controller signs, calls UP.execute(0 CALL, target, 0, data) ---
async function upExecute(ctrl, p, upAddr, target, data, label) {
  const up = new ethers.Contract(upAddr, UP_ABI, ctrl);
  const calldata = up.interface.encodeFunctionData('execute', [0, target, 0, data]);
  const tx = { to: upAddr, data: calldata, nonce: await p.getTransactionCount(ctrl.address, 'pending'), gasPrice: await feeOf(p) };
  tx.gasLimit = (await p.estimateGas({ ...tx, from: ctrl.address })) * 130n / 100n;
  const t = await ctrl.sendTransaction(tx);
  console.log(`  ${label}: ${t.hash}`);
  await p.waitForTransaction(t.hash, 2, 180_000);
  return t.hash;
}

async function main() {
  const p = await connect();
  console.log('RPC connected, chain 42');
  const st = load(path.join(__dirname, 'state.json'));
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, p);
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey, p);
  const aliceUP = ethers.getAddress(st.alice.upAddress);
  const bobUP = ethers.getAddress(st.bob.upAddress);
  console.log('alice UP', aliceUP, '\nbob   UP', bobUP);

  const aK = await deriveConv(aliceCtrl);
  const bK = await deriveConv(bobCtrl);
  const aPub = ethers.hexlify(aK.convPub), bPub = ethers.hexlify(bK.convPub);
  console.log('convPub alice', aPub, '\nconvPub bob  ', bPub);

  const reg = new ethers.Contract(REGISTRY, REG_ABI, p);
  const regIface = new ethers.Interface(REG_ABI);

  // 1 & 2: announce each UP's conv-pub (idempotent — skip if already current)
  for (const [name, upAddr, ctrl, pub] of [
    ['alice', aliceUP, aliceCtrl, aPub],
    ['bob', bobUP, bobCtrl, bPub],
  ]) {
    const onchain = await reg.convPubOf(upAddr);
    if (onchain.toLowerCase() === pub.toLowerCase()) {
      console.log(`  ${name} already announced (match) ✓`);
    } else {
      const data = regIface.encodeFunctionData('announce', [pub]);
      await upExecute(ctrl, p, upAddr, REGISTRY, data, `${name} announce`);
    }
  }

  // verify both announced
  const aOn = await reg.convPubOf(aliceUP), bOn = await reg.convPubOf(bobUP);
  if (aOn.toLowerCase() !== aPub.toLowerCase() || bOn.toLowerCase() !== bPub.toLowerCase())
    throw new Error('announce verify failed');
  console.log('both convPubs live on RegistryV3 ✓');

  // 3: alice UP sends an ENCRYPTED wall post to bob
  const threadId = threadIdFor(aliceUP, bobUP);
  const plaintext = `DM proof ${new Date().toISOString()}: alice -> bob, on-chain sealed.`;
  const key = conversationKey(aK.convPriv, bK.convPub, threadId); // alice's view
  const sealed = await seal(enc.encode(plaintext), key);
  const wallIface = new ethers.Interface(WALL_ABI);
  const postData = wallIface.encodeFunctionData('post', [bobUP, true, threadId, sealed]);
  const txHash = await upExecute(aliceCtrl, p, aliceUP, WALL, postData, 'alice encrypted DM post');

  // 4: read Wall back, find our post, decrypt as BOB
  const wall = new ethers.Contract(WALL, WALL_ABI, p);
  const latest = await p.getBlockNumber();
  const logs = await wall.queryFilter(wall.filters.Posted(null, aliceUP, bobUP), latest - 900, latest);
  const mine = logs.filter((l) => l.args.encrypted && l.args.threadId.toLowerCase() === threadId.toLowerCase()).pop();
  if (!mine) throw new Error('posted event not found on read-back');
  const bobKey = conversationKey(bK.convPriv, aK.convPub, threadId); // bob's view (ECDH symmetric)
  const opened = dec.decode(await open(ethers.getBytes(mine.args.body), bobKey));

  console.log('\n--- READ-BACK + DECRYPT (as bob) ---');
  console.log('threadId  ', threadId);
  console.log('ciphertext', ethers.hexlify(mine.args.body).slice(0, 42) + '…', `(${ethers.getBytes(mine.args.body).length} B)`);
  console.log('decrypted ', JSON.stringify(opened));
  console.log('match     ', opened === plaintext ? 'YES ✓' : 'NO ✗');
  if (opened !== plaintext) throw new Error('decrypt mismatch');

  console.log('\n=== DM ROUND-TRIP PROVEN ON-CHAIN ===');
  console.log('post tx  ', link('tx', txHash));
  console.log('wall     ', link('address', WALL));
  console.log('registry ', link('address', REGISTRY));
}
main().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
