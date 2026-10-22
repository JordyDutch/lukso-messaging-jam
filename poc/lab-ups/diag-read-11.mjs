// Reproduce the browser's exact fetchBlobBody read path for a real PostedBlob,
// hitting the PUBLIC RPC + PUBLIC beacon directly (node reaches these fine).
import { createRequire } from 'module';
const require = createRequire('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/x');
const { ethers } = require('ethers');

const RPC = 'https://rpc.mainnet.lukso.network';
const BEACON = 'https://rpc.mainnet.lukso.network';
const WALL = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const ABI = [
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const wall = new ethers.Contract(WALL, ABI, provider);

const head = await provider.getBlockNumber();
console.log('head block', head);
// scan last 5000 blocks in 1000 chunks for PostedBlob
let logs = [];
for (let lo = head - 5000; lo <= head; lo += 1000) {
  const hi = Math.min(lo + 999, head);
  const ls = await wall.queryFilter(wall.filters.PostedBlob(), lo, hi);
  logs = logs.concat(ls);
}
console.log('PostedBlob events found:', logs.length);
for (const l of logs) {
  console.log(`  id=${Number(l.args.id)} from=${l.args.from} enc=${l.args.encrypted} blobHash=${l.args.blobHash} metaLen=${ethers.getBytes(l.args.meta).length} tx=${l.transactionHash}`);
}

if (!logs.length) { console.log('NO BLOB POSTS IN WINDOW'); process.exit(0); }

const target = logs[logs.length - 1];
const txHash = target.transactionHash;
const anchoredHash = target.args.blobHash;
console.log('\n=== read path for id', Number(target.args.id), '===');

const rcpt = await provider.getTransactionReceipt(txHash);
const blk = await provider.getBlock(rcpt.blockNumber);
console.log('block', rcpt.blockNumber, 'ts', Number(blk.timestamp));

const g = await fetch(`${BEACON}/eth/v1/beacon/genesis`).then(r=>r.json());
const genesis = Number(g.data.genesis_time);
const slot = Math.floor((Number(blk.timestamp) - genesis) / 12);
console.log('genesis', genesis, 'slot', slot);

const res = await fetch(`${BEACON}/eth/v1/beacon/blob_sidecars/${slot}`);
console.log('sidecars status', res.status);
if (!res.ok) { console.log('SIDECARS NOT OK'); process.exit(0); }
const j = await res.json();
const sidecars = j.data ?? [];
console.log('sidecar count', sidecars.length);

async function vh(commitHex){
  const commit = ethers.getBytes(commitHex);
  const digest = ethers.getBytes(ethers.sha256(commit));
  digest[0] = 0x01;
  return ethers.hexlify(digest);
}
let matched = null;
for (const sc of sidecars) {
  const h = await vh(sc.kzg_commitment);
  const m = h.toLowerCase() === anchoredHash.toLowerCase();
  console.log('  sidecar vh', h, m ? '<== MATCH' : '');
  if (m) matched = sc;
}
if (!matched) { console.log('NO MATCH — anchored', anchoredHash); process.exit(0); }

function decodeBlob(blob){
  const len = (blob[28]<<24)|(blob[29]<<16)|(blob[30]<<8)|blob[31];
  const out = new Uint8Array(len);
  let o=0;
  for(let w=1; w<4096 && o<len; w++){ const base=w*32+1; for(let i=0;i<31&&o<len;i++) out[o++]=blob[base+i]; }
  return out;
}
const body = decodeBlob(ethers.getBytes(matched.blob));
console.log('decoded body len', body.length);
console.log('BODY TEXT:', JSON.stringify(new TextDecoder().decode(body)));
