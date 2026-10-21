// inspect-wall.mjs — read live Wall + RegistryV3 state: recent posts, who
// announced a conv-pub, and decode plaintext bodies. Read-only.
'use strict';
import { ethers } from 'ethers';

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const WALL = '0xd3a767c7fE981524810aF7bdE05FA6537B96f58E';
const REGISTRY = '0x01AC2FE086C2D69923F199d47C85688aB2FA088c';
const ALICE = '0xA02B2b0cB13a87824B0e42C951de3B1a20ECbA5C';
const BOB = '0xf380f128b69c5EC2dffafC7Dd3f80DFDed0f509C';
const WALL_ABI = [
  'function count() view returns (uint256)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
];
const REG_ABI = ['function convPubOf(address) view returns (bytes32)'];
const dec = new TextDecoder();

async function connect() {
  for (const rpc of RPCS) {
    try { const p = new ethers.JsonRpcProvider(rpc); if ((await p.getNetwork()).chainId === 42n) return p; } catch {}
  }
  throw new Error('no rpc');
}
async function getLogsChunked(wall, filt, from, to) {
  const out = [];
  for (let lo = from; lo <= to; lo += 1000) {
    const hi = Math.min(lo + 999, to);
    out.push(...await wall.queryFilter(filt, lo, hi));
  }
  return out;
}

const p = await connect();
const wall = new ethers.Contract(WALL, WALL_ABI, p);
const reg = new ethers.Contract(REGISTRY, REG_ABI, p);
const head = await p.getBlockNumber();
const total = await wall.count();
console.log('Wall count:', total.toString(), '| head block', head);

// last ~8000 blocks of posts (chunked to respect the 1000-block cap)
const logs = await getLogsChunked(wall, wall.filters.Posted(), head - 8000, head);
console.log('\n=== recent Wall posts ===');
const addrs = new Set();
for (const l of logs.sort((a, b) => Number(a.args.id) - Number(b.args.id))) {
  const a = l.args;
  addrs.add(ethers.getAddress(a.from));
  if (a.tag !== ethers.ZeroAddress) addrs.add(ethers.getAddress(a.tag));
  const kind = a.encrypted ? '🔒DM ' : '🧱pub';
  const tag = a.tag === ethers.ZeroAddress ? '(no tag)' : a.tag;
  let body;
  if (a.encrypted) body = `<ciphertext ${ethers.getBytes(a.body).length}B>`;
  else { try { body = JSON.stringify(dec.decode(ethers.getBytes(a.body))); } catch { body = '<bin>'; } }
  console.log(`#${a.id} ${kind} from=${a.from} -> ${tag}  blk=${l.blockNumber}`);
  console.log(`      thread=${a.threadId.slice(0, 18)}…  body=${body}`);
}

console.log('\n=== conv-pub announcements (who can receive DMs) ===');
for (const addr of addrs) {
  const cp = await reg.convPubOf(addr);
  const named = addr.toLowerCase() === ALICE.toLowerCase() ? ' (alice-lab)'
    : addr.toLowerCase() === BOB.toLowerCase() ? ' (bob-lab)' : '';
  console.log(`${addr}${named}: ${/^0x0*$/.test(cp) ? 'NOT announced' : cp}`);
}
