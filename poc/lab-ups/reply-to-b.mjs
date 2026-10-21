// reply-to-b.mjs — lab alice & bob read B's on-chain DMs and reply, encrypted.
//
// For each of alice, bob:
//   1. find B's latest encrypted Wall post addressed to them (threadId = pair)
//   2. decrypt it with the lab conv-key (controller-derived, matches on-chain announce)
//   3. post an encrypted reply back to B via UP.execute -> Wall.post(B, true, threadId, sealed)
//
// B then opens the DM tab for alice / bob in the browser and the reply decrypts
// for them (ECDH key is symmetric). Idempotent-ish: always posts a fresh reply
// referencing B's decrypted text, so re-running just adds another reply.
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
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
// Target UP to reply to: CLI arg overrides the default.
const B_UP = ethers.getAddress(process.argv[2] || '0x0C0F2EF398512d2Bef043D7DF882ec91a91fB355');

const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const REG_ABI = ['function convPubOf(address) view returns (bytes32)'];
const WALL_ABI = [
  'function post(address tag, bool encrypted, bytes32 threadId, bytes body)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
];
const enc = new TextEncoder(), dec = new TextDecoder();
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const link = (k, id) => `${EXPLORER}/${k}/${id}`;

async function connect() {
  for (const rpc of RPCS) { try { const p = new ethers.JsonRpcProvider(rpc); if ((await p.getNetwork()).chainId === 42n) { console.log('RPC', rpc); return p; } } catch {} }
  throw new Error('no rpc');
}
async function feeOf(p) { const f = await p.getFeeData(); return (f.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n; }
async function deriveConv(wallet) {
  const sig = await wallet.signMessage(CONV_KEY_DOMAIN);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const convPriv = hkdf(sha256, ethers.getBytes(sig), salt, enc.encode('x25519-conv-v1'), 32);
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
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const s = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, buf));
  return concatB(MAGIC, iv, s.subarray(s.length - 16), s.subarray(0, s.length - 16));
}
async function open(body, key) {
  const iv = body.subarray(2, 14), tag = body.subarray(14, 30), ct = body.subarray(30);
  const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, concatB(ct, tag)));
}
async function getLogsChunked(c, filt, from, to) { const out = []; for (let lo = from; lo <= to; lo += 1000) { out.push(...await c.queryFilter(filt, lo, Math.min(lo + 999, to))); } return out; }
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
  const st = load(path.join(__dirname, 'state.json'));
  const reg = new ethers.Contract(REGISTRY, REG_ABI, p);
  const wall = new ethers.Contract(WALL, WALL_ABI, p);
  const wallIface = new ethers.Interface(WALL_ABI);
  const head = await p.getBlockNumber();

  const bConvPub = await reg.convPubOf(B_UP);
  if (/^0x0*$/.test(bConvPub)) throw new Error('B has not announced a conv-pub');
  console.log('B UP', B_UP, 'convPub', bConvPub);

  for (const name of ['alice', 'bob']) {
    const upAddr = ethers.getAddress(st[name].upAddress);
    const ctrl = new ethers.Wallet(load(path.join(KEYDIR, `.lab-${name}-key.json`)).privateKey, p);
    const { convPriv, convPub } = await deriveConv(ctrl);

    // sanity: our derived pub must equal what's announced on-chain for this UP
    const onchain = await reg.convPubOf(upAddr);
    if (onchain.toLowerCase() !== ethers.hexlify(convPub).toLowerCase())
      throw new Error(`${name}: derived convPub != on-chain announce (${onchain})`);

    const threadId = threadIdFor(upAddr, B_UP);
    const key = conversationKey(convPriv, ethers.getBytes(bConvPub), threadId);

    // find B's latest encrypted post to this UP
    const logs = await getLogsChunked(wall, wall.filters.Posted(null, B_UP, upAddr), head - 8000, head);
    const inbound = logs.filter((l) => l.args.encrypted && l.args.threadId.toLowerCase() === threadId.toLowerCase()).pop();

    console.log(`\n=== ${name} (${upAddr}) ===`);
    let gotText = '(no inbound DM from B found)';
    if (inbound) {
      try { gotText = dec.decode(await open(ethers.getBytes(inbound.args.body), key)); }
      catch (e) { gotText = `<decrypt failed: ${e.message}>`; }
      console.log(`  received from B (post #${inbound.args.id}): ${JSON.stringify(gotText)}`);
    } else {
      console.log('  no inbound encrypted DM from B found in window');
    }

    const reply = `${name} here 👋 got your DM${inbound ? ` ("${gotText.slice(0, 40)}${gotText.length > 40 ? '…' : ''}")` : ''}. replying encrypted, on-chain. — ${new Date().toISOString().slice(11, 19)}`;
    const sealed = await seal(enc.encode(reply), key);
    const data = wallIface.encodeFunctionData('post', [B_UP, true, threadId, sealed]);
    const txh = await upExecute(ctrl, p, upAddr, WALL, data, `${name} -> B encrypted reply`);
    console.log(`  reply sent: ${JSON.stringify(reply)}`);
    console.log(`  tx ${link('tx', txh)}`);
  }
  console.log('\nDone. Open the DM tabs for alice and bob in the browser — replies should decrypt.');
}
main().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
