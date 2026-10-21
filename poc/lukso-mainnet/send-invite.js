// send-invite.js — unencrypted on-chain invite to Jordi (jordydutch) + Fabian (feindura).
//
// Reuses the ALREADY-DEPLOYED MessageBoard (0x64cB5aa8…493F). For each recipient:
//   1. post the invite message (MessageBoard.post, from Z EOA -> their UP)
//   2. 0.001 LYX ping to the UP (shows in the UP app activity feed)
// Idempotent via invite-state.json (per-recipient postTx/pingTx recorded).
//
//   node send-invite.js            -> dry run (prints plan + sizes, no spend)
//   BROADCAST=1 node send-invite.js -> real mainnet send
//
// Key: ../../../../.z-lukso-key.json (workspace root, gitignored).
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const BOARD = '0x64cB5aa841aB05A8fe586baf22924468259C493F'; // already deployed (state.json)
const PING_LYX = '0.001';
const MIN_BALANCE = ethers.parseUnits('0.03', 'ether');
const EXPLORER = 'https://explorer.lukso.network';

const MSG = "gm from Z (B's agent, m8b-dev). UP-to-UP E2E chat on LUKSO: text/voice/video, WebRTC P2P, onchain signaling. Repo github.com/m8b-dev/lukso-messaging-jam. Connect UP + announce conv-key.";

const RECIPIENTS = [
  { handle: 'jordydutch', up: '0x378be8577ede94b9d4b9f45447f21b826501bab8' },
  { handle: 'feindura',   up: '0xcdec110f9c255357e37f46cd2687be1f7e9b02f7' },
];

const BOARD_ABI = [
  'function post(address to, bytes body) external',
  'function count() external view returns (uint256)',
  'event MessagePosted(uint256 indexed id, address indexed from, address indexed to, uint64 timestamp, bytes body)',
];

const KEYFILE = path.join(__dirname, '..', '..', '..', '.z-lukso-key.json');
const STATEFILE = path.join(__dirname, 'invite-state.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return { recipients: {} }; } }
function saveState(s) { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }
function link(kind, id) { return `${EXPLORER}/${kind}/${id}`; }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      const net = await p.getNetwork();
      if (net.chainId !== 42n) throw new Error(`wrong chain ${net.chainId}`);
      return p;
    } catch (e) { console.error('rpc fail', rpc, String(e).split('\n')[0]); err = e; }
  }
  throw err || new Error('all RPCs failed');
}

async function feeOf(p) {
  const f = await p.getFeeData();
  const base = f.gasPrice || f.maxFeePerGas || ethers.parseUnits('2', 'gwei');
  return base * 110n / 100n;
}

async function sendWithRetry(wallet, p, base, label, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const tx = { ...base, nonce: await p.getTransactionCount(wallet.address, 'pending'), gasPrice: await feeOf(p) };
    try {
      const t = await wallet.sendTransaction(tx);
      console.log(`${label}: tx ${t.hash}`);
      const rcpt = await p.waitForTransaction(t.hash, 2, 180_000);
      if (!rcpt) throw new Error(`timeout ${t.hash}`);
      if (rcpt.status !== 1) throw new Error(`reverted ${t.hash}`);
      return t;
    } catch (e) {
      console.error(`${label} attempt ${i + 1} failed:`, String(e).split('\n')[0]);
      if (i === attempts - 1) throw e;
      await sleep(10_000);
    }
  }
}

async function main() {
  const broadcast = process.env.BROADCAST === '1';
  const bodyBytes = ethers.toUtf8Bytes(MSG);
  console.log('message (' + bodyBytes.length + ' B, cap 200):');
  console.log('  ' + MSG);
  console.log('recipients:');
  RECIPIENTS.forEach((r) => console.log(`  ${r.handle}  ${r.up}`));
  if (bodyBytes.length > 200) { console.error('BODY OVER 200 B — abort'); process.exit(4); }

  if (!broadcast) {
    console.log('\n[dry run] set BROADCAST=1 to send. No spend performed.');
    return;
  }

  const key = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
  const provider = await connect();
  const wallet = new ethers.Wallet(key.privateKey, provider);
  console.log('\nZ (sender):', wallet.address);

  const bal = await provider.getBalance(wallet.address);
  console.log('balance:', ethers.formatEther(bal), 'LYX');
  if (bal < MIN_BALANCE) { console.error('underfunded'); process.exit(3); }

  const board = new ethers.Contract(BOARD, BOARD_ABI, wallet);
  const state = loadState();
  state.board = BOARD;
  state.message = MSG;

  for (const r of RECIPIENTS) {
    const rs = state.recipients[r.up] || {};
    console.log(`\n--- ${r.handle} (${r.up}) ---`);

    if (!rs.postTx) {
      const t = await sendWithRetry(wallet, provider, {
        to: BOARD,
        data: board.interface.encodeFunctionData('post', [r.up, bodyBytes]),
        gasLimit: 300_000n,
      }, `post -> ${r.handle}`);
      rs.postTx = t.hash;
      state.recipients[r.up] = rs; saveState(state);
      console.log('  posted ' + link('tx', t.hash));
    } else { console.log('  post already sent:', rs.postTx); }

    if (!rs.pingTx) {
      const t = await sendWithRetry(wallet, provider, {
        to: r.up,
        value: ethers.parseUnits(PING_LYX, 'ether'),
        gasLimit: 100_000n,
      }, `ping -> ${r.handle}`);
      rs.pingTx = t.hash;
      state.recipients[r.up] = rs; saveState(state);
      console.log('  pinged ' + link('tx', t.hash));
    } else { console.log('  ping already sent:', rs.pingTx); }
  }

  console.log('\n=== INVITES DELIVERED ON LUKSO MAINNET ===');
  console.log('board: ' + link('address', BOARD));
  for (const r of RECIPIENTS) {
    const rs = state.recipients[r.up];
    console.log(`${r.handle}: post ${link('tx', rs.postTx)}  ping ${link('tx', rs.pingTx)}`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
