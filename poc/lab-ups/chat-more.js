// chat-more.js — continue the alice <-> bob conversation on LUKSO mainnet.
// Reuses the board + UPs from chat.js. Idempotent via chat-more-state.json.
// Sends an ordered list of UP->UP posts; each new line is one more on-chain message.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const UP_STATE = path.join(__dirname, 'state.json');
const CHAT_STATE = path.join(__dirname, 'chat-state.json');
const STATEFILE = path.join(__dirname, 'chat-more-state.json');

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
async function upPost(provider, ctrl, upAddr, board, to, text, label) {
  const up = new ethers.Contract(upAddr, UP_ABI, ctrl);
  const boardIface = new ethers.Interface(BOARD_ABI);
  const data = boardIface.encodeFunctionData('post', [to, ethers.toUtf8Bytes(text)]);
  const calldata = up.interface.encodeFunctionData('execute', [0, board, 0n, data]);
  let gasLimit = 500_000n;
  try { gasLimit = (await provider.estimateGas({ from: ctrl.address, to: upAddr, data: calldata })) * 150n / 100n; } catch {}
  return send(ctrl, provider, { to: upAddr, data: calldata, gasLimit }, label);
}

async function main() {
  const provider = await connect();
  const ups = load(UP_STATE);
  const chat = load(CHAT_STATE);
  const aliceUP = ups.alice.upAddress, bobUP = ups.bob.upAddress, board = chat.board;
  const alice = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, provider);
  const bob = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey, provider);
  const state = load(STATEFILE); state.sent = state.sent || [];

  // the continuing thread — each entry is one more on-chain UP->UP message
  const thread = [
    { who: 'alice', text: 'bob, round 2 - the KeyManager routing works clean. want to move the thread off-chain next?' },
    { who: 'bob',   text: 'alice, agreed. on-chain for signaling, payload over WebRTC P2P. anchor the conv-key here.' },
    { who: 'alice', text: 'bob, perfect. this board is our signaling log then. gm from the lab. [end round]' },
  ];

  console.log('aliceUP:', aliceUP, '| bobUP:', bobUP, '| board:', board);
  for (let i = 0; i < thread.length; i++) {
    if (state.sent[i]) { console.log(`  [${i}] already sent:`, state.sent[i]); continue; }
    const m = thread[i];
    const from = m.who === 'alice' ? alice : bob;
    const fromUP = m.who === 'alice' ? aliceUP : bobUP;
    const toUP = m.who === 'alice' ? bobUP : aliceUP;
    const t = await upPost(provider, from, fromUP, board, toUP, m.text, `[${i}] ${m.who}UP -> ${m.who === 'alice' ? 'bob' : 'alice'}UP`);
    state.sent[i] = t.hash; save(state);
  }

  // read back full thread
  const boardR = new ethers.Contract(board, BOARD_ABI, provider);
  const n = await boardR.count();
  const who = (a) => a.toLowerCase() === aliceUP.toLowerCase() ? 'alice' : a.toLowerCase() === bobUP.toLowerCase() ? 'bob' : a;
  console.log('\n=== FULL THREAD (' + n.toString() + ' posts) ===');
  for (let i = 0n; i < n; i++) {
    const pst = await boardR.posts(i); const body = await boardR.postBody(i);
    console.log(`  #${i} ${who(pst.from)} -> ${who(pst.to)}: "${ethers.toUtf8String(body)}"`);
  }
  console.log('\nnew tx links:');
  state.sent.forEach((h, i) => console.log(`  [${i}] ${link('tx', h)}`));
  console.log('board:', link('address', board));
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
