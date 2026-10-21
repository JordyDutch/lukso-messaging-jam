// correct-record.js — one alice->bob on-chain post correcting the transport record.
// Idempotent via correct-record-state.json. Reuses board + UPs from chat.js/state.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const UP_STATE = path.join(__dirname, 'state.json');
const CHAT_STATE = path.join(__dirname, 'chat-state.json');
const STATEFILE = path.join(__dirname, 'correct-record-state.json');

const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const BOARD_ABI = [
  'function post(address to, bytes body)',
  'function count() view returns (uint256)',
  'function posts(uint256) view returns (address from, address to, uint64 timestamp, uint256 id)',
  'function postBody(uint256) view returns (bytes)',
];

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function save(s) { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }
function link(kind, id) { return `${EXPLORER}/${kind}/${id}`; }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try { const p = new ethers.JsonRpcProvider(rpc); if ((await p.getNetwork()).chainId !== 42n) throw new Error('chain'); console.log('RPC:', rpc); return p; } catch (e) { err = e; }
  }
  throw err;
}
async function feeOf(p) { const f = await p.getFeeData(); return (f.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n; }
async function send(wallet, p, base, label) {
  const tx = { ...base, nonce: await p.getTransactionCount(wallet.address, 'pending'), gasPrice: await feeOf(p) };
  const t = await wallet.sendTransaction(tx);
  console.log(`  ${label}: ${t.hash}`);
  const r = await p.waitForTransaction(t.hash, 2, 180_000);
  if (!r || r.status !== 1) throw new Error(`${label} reverted: ${t.hash}`);
  return t;
}

async function main() {
  const provider = await connect();
  const ups = load(UP_STATE);
  const chat = load(CHAT_STATE);
  const aliceUP = ups.alice.upAddress, bobUP = ups.bob.upAddress, board = chat.board;
  const alice = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, provider);
  const state = load(STATEFILE);

  const text = 'bob, correction: ignore the wireguard line - transport is WebRTC, chain is signaling only.';

  console.log('aliceUP:', aliceUP, '| bobUP:', bobUP, '| board:', board);
  if (!state.hash) {
    const up = new ethers.Contract(aliceUP, UP_ABI, alice);
    const boardIface = new ethers.Interface(BOARD_ABI);
    const data = boardIface.encodeFunctionData('post', [bobUP, ethers.toUtf8Bytes(text)]);
    const calldata = up.interface.encodeFunctionData('execute', [0, board, 0n, data]);
    let gasLimit = 500_000n;
    try { gasLimit = (await provider.estimateGas({ from: alice.address, to: aliceUP, data: calldata })) * 150n / 100n; } catch {}
    const t = await send(alice, provider, { to: aliceUP, data: calldata, gasLimit }, 'aliceUP -> bobUP (correction)');
    state.hash = t.hash; save(state);
  } else {
    console.log('  already sent:', state.hash);
  }

  const boardR = new ethers.Contract(board, BOARD_ABI, provider);
  const n = await boardR.count();
  const who = (a) => a.toLowerCase() === aliceUP.toLowerCase() ? 'alice' : a.toLowerCase() === bobUP.toLowerCase() ? 'bob' : a;
  console.log('\n=== FULL THREAD (' + n.toString() + ' posts) ===');
  for (let i = 0n; i < n; i++) {
    const pst = await boardR.posts(i); const body = await boardR.postBody(i);
    console.log(`  #${i} ${who(pst.from)} -> ${who(pst.to)}: "${ethers.toUtf8String(body)}"`);
  }
  console.log('\ncorrection tx:', link('tx', state.hash));
  console.log('board:', link('address', board));
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
