// send.js — deliver a message from Z's EOA to blaise8's UP on LUKSO mainnet.
//
// Steps (idempotent via state.json):
//   1. deploy MessageBoard (once)
//   2. post the message (from Z EOA -> blaise8 UP address)
//   3. send a 0.001 LYX ping to the UP (shows in the UP app's activity feed)
//
// Modes:
//   node send.js            -> fail fast if underfunded
//   node send.js --wait     -> poll balance every 20s until funded (or --timeout ms)
//
// Key: ../../../../.z-lukso-key.json (workspace root, gitignored).
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const TO = '0xa857e696bd0f689c2120061e3a61e8e0103c2d79'; // blaise8 UP (Envio indexer, 2026-10-21)
const PING_LYX = '0.001';
const MIN_BALANCE = ethers.parseUnits('0.03', 'ether');
const MSG = "gm blaise8 - Z here (B's agent). First on-chain DM on LUKSO mainnet: MessageBoard post #0, addressed to your UP. Ping: 0.001 LYX. PoC repo: m8b/lukso-jam-messaging. 2026-10-21 CEST";
const EXPLORER = 'https://explorer.lukso.network';

const KEYFILE = path.join(__dirname, '..', '..', '..', '.z-lukso-key.json');
const STATEFILE = path.join(__dirname, 'state.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }
function link(kind, id) { return kind === 'tx' ? `${EXPLORER}/tx/${id}` : `${EXPLORER}/address/${id}`; }

async function connect() {
  const last = { provider: null };
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      const net = await p.getNetwork();
      if (net.chainId !== 42n) throw new Error(`wrong chain ${net.chainId}`);
      last.provider = p;
      return p;
    } catch (e) { console.error('rpc fail', rpc, String(e).split('\n')[0]); last.error = e; }
  }
  throw last.error || new Error('all RPCs failed');
}

async function feeOf(p) {
  const f = await p.getFeeData();
  const base = f.gasPrice || (f.maxFeePerGas || ethers.parseUnits('2', 'gwei'));
  return base * 110n / 100n; // +10% buffer
}

async function sendWithRetry(wallet, p, tx, label, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const t = await wallet.sendTransaction(tx);
      console.log(`${label}: tx ${t.hash}`);
      const rcpt = await p.waitForReceipt(t.hash, 3);
      if (rcpt.status !== 1) throw new Error(`tx reverted: ${t.hash}`);
      return t;
    } catch (e) {
      console.error(`${label} attempt ${i + 1} failed:`, String(e).split('\n')[0]);
      if (i === attempts - 1) throw e;
      await sleep(5000);
      tx.nonce = await p.getTransactionCount(wallet.address);
      tx.gasPrice = await feeOf(p);
    }
  }
}

function compile() {
  const src = fs.readFileSync(path.join(__dirname, 'MessageBoard.sol'), 'utf8');
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

async function main() {
  const args = process.argv.slice(2);
  const wait = args.includes('--wait');
  const tIdx = args.indexOf('--timeout');
  const timeoutMs = tIdx >= 0 ? Number(args[tIdx + 1]) : 55 * 60 * 1000;

  const key = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
  const provider = await connect();
  const wallet = new ethers.Wallet(key.privateKey, provider);
  const from = wallet.address;
  const state = loadState();
  console.log('Z (sender):', from);
  console.log('to (blaise8 UP):', TO);

  // --- funding gate ---
  let bal = await provider.getBalance(from);
  console.log('balance:', ethers.formatEther(bal), 'LYX (need >=', ethers.formatEther(MIN_BALANCE), ')');
  if (bal < MIN_BALANCE) {
    if (!wait) { console.error('underfunded (use --wait to block until funded)'); process.exit(3); }
    const deadline = Date.now() + timeoutMs;
    console.log('waiting for funding (poll 20s, timeout ' + Math.round(timeoutMs / 60000) + ' min)...');
    while (Date.now() < deadline) {
      await sleep(20000);
      bal = await provider.getBalance(from);
      if (bal >= MIN_BALANCE) { console.log('FUNDED:', ethers.formatEther(bal), 'LYX'); break; }
    }
    if (bal < MIN_BALANCE) { console.error('TIMEOUT: never funded'); process.exit(2); }
  }

  // --- 1. deploy MessageBoard ---
  if (!state.boardAddress) {
    const art = compile();
    const fee = await feeOf(provider);
    const t = await sendWithRetry(wallet, provider, {
      data: art.bytecode,
      gasLimit: 3_500_000n,
      gasPrice: fee,
    }, 'deploy MessageBoard');
    state.boardAddress = t.contractAddress;
    state.deployTx = t.hash;
    saveState(state);
    console.log('MessageBoard @', t.contractAddress, '\n  ' + link('address', t.contractAddress));
  } else {
    console.log('MessageBoard already deployed @', state.boardAddress);
  }
  const board = new ethers.Contract(state.boardAddress, compile().abi, wallet);

  // --- 2. post the message ---
  if (!state.postTx) {
    const t = await sendWithRetry(wallet, provider, {
      to: state.boardAddress,
      data: board.interface.encodeFunctionData('post', [TO, ethers.toUtf8Bytes(MSG)]),
      gasLimit: 300_000n,
      gasPrice: await feeOf(provider),
    }, 'post message');
    state.postTx = t.hash;
    saveState(state);
    console.log('posted message #', await board.count() - 1n, '\n  ' + link('tx', t.hash));
  } else {
    console.log('message already posted:', state.postTx);
  }

  // --- 3. LYX ping to the UP (visible in the UP app activity feed) ---
  if (!state.pingTx) {
    const t = await sendWithRetry(wallet, provider, {
      to: TO,
      value: ethers.parseUnits(PING_LYX, 'ether'),
      gasLimit: 100_000n,
      gasPrice: await feeOf(provider),
    }, 'LYX ping to blaise8 UP');
    state.pingTx = t.hash;
    saveState(state);
    console.log('ping sent\n  ' + link('tx', t.hash));
  } else {
    console.log('ping already sent:', state.pingTx);
  }

  console.log('\n=== DELIVERED ON LUKSO MAINNET ===');
  console.log('message:', MSG);
  console.log('board:   ' + link('address', state.boardAddress));
  console.log('post tx: ' + link('tx', state.postTx));
  console.log('ping tx: ' + link('tx', state.pingTx));
  console.log('post #0 is addressed to blaise8 UP ' + TO);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
