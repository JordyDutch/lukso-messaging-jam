// chat.js — alice UP and bob UP talk to each other on LUKSO mainnet.
//
// Prereq: deploy-ups.js has run (state.json has alice/bob UP addresses).
// Flow (idempotent via chat-state.json):
//   1. deploy MessageBoard once (from Z EOA)
//   2. aliceUP -> post msg to bobUP + 0.001 LYX ping   (signed by alice controller)
//   3. bobUP   -> reply to aliceUP + 0.001 LYX ping     (signed by bob controller)
//   4. read back the board: both posts, from/to = the UPs
//
// A UP action = controller calls UP.execute(0 CALL, target, value, data).
// The UP is owned by its KeyManager, but LSP0 supports LSP20 call verification:
// calling execute() directly from a controller with ALL_PERMISSIONS is verified
// by the KeyManager automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const solc = require('solc');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const STATEFILE = path.join(__dirname, 'chat-state.json');
const UP_STATE = path.join(__dirname, 'state.json');
const PING = ethers.parseUnits('0.001', 'ether');

const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const BOARD_ABI = [
  'function post(address to, bytes body)',
  'function count() view returns (uint256)',
  'function posts(uint256) view returns (address from, address to, uint64 timestamp, uint256 id)',
  'function postBody(uint256) view returns (bytes)',
  'event MessagePosted(uint256 indexed id, address indexed from, address indexed to, uint64 timestamp, bytes body)',
];

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function save(s) { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }
function link(kind, id) { return `${EXPLORER}/${kind}/${id}`; }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      if ((await p.getNetwork()).chainId !== 42n) throw new Error('wrong chain');
      console.log('RPC:', rpc);
      return p;
    } catch (e) { err = e; }
  }
  throw err;
}
async function feeOf(p) {
  const f = await p.getFeeData();
  return (f.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n;
}
async function send(wallet, p, base, label) {
  const tx = { ...base, nonce: await p.getTransactionCount(wallet.address, 'pending'), gasPrice: await feeOf(p) };
  const t = await wallet.sendTransaction(tx);
  console.log(`  ${label}: ${t.hash}`);
  const r = await p.waitForTransaction(t.hash, 2, 180_000);
  if (!r || r.status !== 1) throw new Error(`${label} failed/reverted: ${t.hash}`);
  return t;
}
function compileBoard() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lukso-mainnet', 'MessageBoard.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'MessageBoard.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['MessageBoard.sol']['MessageBoard'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// one UP action: controller -> UP.execute(CALL, target, value, data)
async function upAction(provider, controller, upAddress, target, value, data, label) {
  const up = new ethers.Contract(upAddress, UP_ABI, controller);
  const calldata = up.interface.encodeFunctionData('execute', [0, target, value, data]);
  // estimate gas so we size the limit correctly (UP + KM verification overhead)
  let gasLimit = 500_000n;
  try {
    const est = await provider.estimateGas({ from: controller.address, to: upAddress, data: calldata, value: 0n });
    gasLimit = est * 150n / 100n;
  } catch (e) { console.log(`  (gas estimate fallback for ${label}:`, String(e).split('\n')[0], ')'); }
  return send(controller, provider, { to: upAddress, data: calldata, gasLimit }, label);
}

async function main() {
  const provider = await connect();
  const ups = load(UP_STATE);
  if (!ups.alice || !ups.bob) throw new Error('run deploy-ups.js first');
  const aliceUP = ups.alice.upAddress, bobUP = ups.bob.upAddress;

  const z = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, provider);
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey, provider);

  const state = load(STATEFILE);
  console.log('aliceUP:', aliceUP, '| bobUP:', bobUP);

  const board = compileBoard();

  // --- 1. deploy MessageBoard (from Z) ---
  if (!state.board) {
    const t = await send(z, provider, { data: board.bytecode, gasLimit: 800_000n }, 'deploy MessageBoard');
    const rc = await provider.getTransactionReceipt(t.hash);
    state.board = rc.contractAddress;
    save(state);
    console.log('  MessageBoard @', state.board, '\n  ' + link('address', state.board));
  } else {
    console.log('  MessageBoard already @', state.board);
  }
  const boardIface = new ethers.Interface(BOARD_ABI);

  const MSG_A = ethers.toUtf8Bytes('gm bob - alice UP here. first UP->UP message on LUKSO mainnet. 2026-10-21');
  const MSG_B = ethers.toUtf8Bytes('gm alice - bob UP, got it. replying UP->UP, ping back. 2026-10-21');

  // --- 2. aliceUP -> bobUP: post + ping ---
  if (!state.aliceToBobPost) {
    const data = boardIface.encodeFunctionData('post', [bobUP, MSG_A]);
    const t = await upAction(provider, aliceCtrl, aliceUP, state.board, 0n, data, 'aliceUP post -> bobUP');
    state.aliceToBobPost = t.hash; save(state);
  } else { console.log('  aliceUP post already sent:', state.aliceToBobPost); }
  if (!state.aliceToBobPing) {
    const t = await upAction(provider, aliceCtrl, aliceUP, bobUP, PING, '0x', 'aliceUP ping -> bobUP (0.001 LYX)');
    state.aliceToBobPing = t.hash; save(state);
  } else { console.log('  aliceUP ping already sent:', state.aliceToBobPing); }

  // --- 3. bobUP -> aliceUP: reply + ping ---
  if (!state.bobToAlicePost) {
    const data = boardIface.encodeFunctionData('post', [aliceUP, MSG_B]);
    const t = await upAction(provider, bobCtrl, bobUP, state.board, 0n, data, 'bobUP reply -> aliceUP');
    state.bobToAlicePost = t.hash; save(state);
  } else { console.log('  bobUP reply already sent:', state.bobToAlicePost); }
  if (!state.bobToAlicePing) {
    const t = await upAction(provider, bobCtrl, bobUP, aliceUP, PING, '0x', 'bobUP ping -> aliceUP (0.001 LYX)');
    state.bobToAlicePing = t.hash; save(state);
  } else { console.log('  bobUP ping already sent:', state.bobToAlicePing); }

  // --- 4. read back ---
  const boardR = new ethers.Contract(state.board, BOARD_ABI, provider);
  const n = await boardR.count();
  console.log('\n=== CONVERSATION ON-CHAIN (board has', n.toString(), 'posts) ===');
  for (let i = 0n; i < n; i++) {
    const pst = await boardR.posts(i);
    const body = await boardR.postBody(i);
    const who = (a) => a.toLowerCase() === aliceUP.toLowerCase() ? 'alice' : a.toLowerCase() === bobUP.toLowerCase() ? 'bob' : a;
    console.log(`  #${i} ${who(pst.from)} -> ${who(pst.to)}: "${ethers.toUtf8String(body)}"`);
  }
  console.log('\nlinks:');
  console.log('  board:', link('address', state.board));
  console.log('  alice->bob post:', link('tx', state.aliceToBobPost), '| ping:', link('tx', state.aliceToBobPing));
  console.log('  bob->alice post:', link('tx', state.bobToAlicePost), '| ping:', link('tx', state.bobToAlicePing));
  console.log('\nbalances now:');
  console.log('  aliceUP:', ethers.formatEther(await provider.getBalance(aliceUP)), 'LYX');
  console.log('  bobUP  :', ethers.formatEther(await provider.getBalance(bobUP)), 'LYX');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
