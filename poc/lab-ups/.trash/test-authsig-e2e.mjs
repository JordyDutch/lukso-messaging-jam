// test-authsig-e2e.mjs — E2E test of the Option-B author-signature /execute path
// against the LIVE relayer (127.0.0.1:3100). Signs the canonical message with
// alice's controller key (an authorized LSP6 controller of alice's UP) and
// posts a real blob to WallV2 on LUKSO mainnet. Verifies PostedBlob comes back
// with author = alice's UP.
//
// Run: node test-authsig-e2e.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const { loadKZG } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/kzg-wasm');

const RELAYER = process.env.RELAYER_URL || 'http://127.0.0.1:3100';
const CHAIN_ID = 42;
const WALL = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const ALICE_UP = '0xA02B2b0cB13a87824B0e42C951de3B1a20ECbA5C';
const ZERO = ethers.ZeroAddress;

// alice's controller key (authorized LSP6 controller of ALICE_UP)
const key = JSON.parse(fs.readFileSync('/home/bk/.openclaw/workspace/.lab-alice-key.json', 'utf8'));
const signer = new ethers.Wallet(key.privateKey);

// ---- blob encode (byte-for-byte identical to frontend2/src/lib/blob.ts) ----
const FIELD_ELEMENTS = 4096, BLOB_SIZE = FIELD_ELEMENTS * 32;
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
const blobHex = (b) => ethers.hexlify(b);

function buildAuthMessage(m) {
  return [
    'up-wall:post:v2',
    `chainId:${m.chainId}`,
    `wall:${m.wall.toLowerCase()}`,
    `up:${m.up.toLowerCase()}`,
    `tag:${m.tag.toLowerCase()}`,
    `encrypted:${m.encrypted ? 1 : 0}`,
    `threadId:${m.threadId.toLowerCase()}`,
    `blobHash:${m.blobHash.toLowerCase()}`,
    `len:${m.len}`,
    `nonce:${m.nonce}`,
  ].join('\n');
}

async function main() {
  const kzg = await loadKZG();
  const body = new TextEncoder().encode(`authsig E2E test ${new Date().toISOString()}`);
  const blob = encodeBlob(body);
  const probe = ethers.Transaction.from({
    type: 3, to: ZERO, chainId: CHAIN_ID, nonce: 0,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n,
    gasLimit: 21000n, data: '0x', blobs: [blobHex(blob)], kzg,
  });
  const blobHash = probe.blobVersionedHashes[0];

  const fields = {
    chainId: CHAIN_ID, wall: WALL, up: ALICE_UP, tag: ZERO,
    encrypted: false, threadId: ethers.ZeroHash, blobHash, len: body.length,
    nonce: Date.now().toString(),
  };
  const message = buildAuthMessage(fields);
  const signature = await signer.signMessage(message);
  console.log('signer (controller):', signer.address);
  console.log('recovered check    :', ethers.verifyMessage(message, signature));
  console.log('blobHash           :', blobHash);

  const reqBody = {
    up: ALICE_UP, upName: 'alice', tag: ZERO, encrypted: false,
    threadId: ethers.ZeroHash, blobHash, len: body.length,
    nonce: fields.nonce, chainId: CHAIN_ID, wall: WALL,
    signature, blob: blobHex(blob),
  };
  const res = await fetch(`${RELAYER}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  console.log(`\n/execute -> HTTP ${res.status}`);
  console.log(text);
  if (res.ok) {
    const j = JSON.parse(text);
    console.log(`\nPASS: txHash=${j.txHash} author=${j.author} from(relayer)=${j.from}`);
  } else {
    console.log('\nFAIL (non-200)');
    process.exit(1);
  }
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
