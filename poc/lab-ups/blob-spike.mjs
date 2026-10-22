// blob-spike.mjs — EIP-4844 Type-3 blob transaction spike on LUKSO MAINNET.
//
// Proves the ephemeral-blob + on-chain-hash pattern end to end against the live
// WallV2 contract (docs/BLOB-ARCHITECTURE.md):
//   1. load KZG (kzg-wasm) and inject into ethers v6
//   2. build a 128 KB blob carrying a test payload
//   3. send a Type-3 tx calling WallV2.postBlob(tag, enc, thread, blobHash, meta)
//      attaching the blob — contract binds blobHash == blobhash(0)
//   4. wait for the receipt, parse the PostedBlob event, assert the anchored
//      hash equals the versioned hash we computed
//
// Settles open questions #1 (can we originate a Type-3 tx from our EOA tooling)
// and #2 (does blobhash(0) bind correctly). This uses Z's raw controller EOA,
// NOT the UP extension — the extension Type-3 question is separate and still
// open; this proves the chain + contract side works.
//
// Run from poc/: node lab-ups/blob-spike.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const { loadKZG } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/kzg-wasm');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';

const ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      if ((await p.getNetwork()).chainId !== 42n) throw new Error('chain');
      console.log('RPC:', rpc);
      return p;
    } catch (e) { err = e; }
  }
  throw err;
}

// A blob is 4096 field elements * 32 bytes = 131072 bytes. Each 32-byte field
// element must be < the BLS modulus, so the canonical safe encoding keeps the
// top byte 0 in every 32-byte word. We write our payload length + bytes into
// the low 31 bytes of successive words.
const FIELD_ELEMENTS = 4096;
const BLOB_SIZE = FIELD_ELEMENTS * 32; // 131072

function encodeBlob(payload) {
  const blob = new Uint8Array(BLOB_SIZE); // zero-filled
  // word 0: 4-byte big-endian length in bytes 28..31 (top byte stays 0)
  const len = payload.length;
  blob[28] = (len >>> 24) & 0xff;
  blob[29] = (len >>> 16) & 0xff;
  blob[30] = (len >>> 8) & 0xff;
  blob[31] = len & 0xff;
  // then 31 payload bytes per 32-byte word (byte 0 of each word left 0)
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1; // skip the high byte
    for (let i = 0; i < 31 && o < len; i++) blob[base + i] = payload[o++];
  }
  return blob;
}

function decodeBlob(blob) {
  const len = (blob[28] << 24) | (blob[29] << 16) | (blob[30] << 8) | blob[31];
  const out = new Uint8Array(len);
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1;
    for (let i = 0; i < 31 && o < len; i++) out[o++] = blob[base + i];
  }
  return out;
}

async function main() {
  console.log('=== EIP-4844 blob spike — LUKSO MAINNET — WallV2 postBlob ===\n');
  const provider = await connect();
  const z = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  console.log('Z (sender EOA):', z.address, ethers.formatEther(await provider.getBalance(z.address)), 'LYX');

  console.log('loading KZG (kzg-wasm, trusted setup)…');
  const kzg = await loadKZG();
  console.log('KZG ready.\n');

  // --- build the payload + blob ---
  const payloadText = `UP Dawg blob spike @ ${new Date().toISOString()} — ephemeral body in an EIP-4844 blob; only its KZG versioned hash is anchored on-chain. 🌭`;
  const payload = new TextEncoder().encode(payloadText);
  console.log('payload:', payload.length, 'bytes:', JSON.stringify(payloadText));

  const blob = encodeBlob(payload);
  // sanity: round-trip decode
  const rt = new TextDecoder().decode(decodeBlob(blob));
  if (rt !== payloadText) throw new Error('blob encode/decode round-trip mismatch');
  console.log('blob built:', blob.length, 'bytes; round-trip OK');

  // --- compute commitment + versioned hash ---
  const blobHex = '0x' + Buffer.from(blob).toString('hex');
  const commitment = kzg.blobToKzgCommitment(blobHex);
  const proof = kzg.computeBlobKzgProof(blobHex, commitment);
  // versioned hash = 0x01 ++ sha256(commitment)[1:]
  const commitmentBytes = ethers.getBytes(commitment.startsWith('0x') ? commitment : '0x' + commitment);
  const sha = ethers.sha256(commitmentBytes);
  const versionedHash = '0x01' + sha.slice(4); // replace first byte (0x01 version)
  console.log('kzg commitment:', (commitment.startsWith('0x') ? commitment : '0x' + commitment).slice(0, 20) + '…');
  console.log('versioned hash:', versionedHash);

  // --- encode the postBlob call ---
  const iface = new ethers.Interface(ABI);
  const tag = z.address;              // self-tag for the test (public, encrypted=false)
  const threadId = ethers.ZeroHash;
  const meta = ethers.toUtf8Bytes(JSON.stringify({ v: 1, len: payload.length, mime: 'text/plain' }));
  const data = iface.encodeFunctionData('postBlob', [tag, false, threadId, versionedHash, meta]);

  // --- fees ---
  const fee = await provider.getFeeData();
  const maxFeePerGas = (fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'));
  const maxPriorityFeePerGas = (fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'));
  const maxFeePerBlobGas = ethers.parseUnits('10', 'gwei'); // way above the 1 wei floor, cheap

  // --- build the Type-3 tx. ethers v6: pass blobs + kzg, it builds the sidecar. ---
  const tx = {
    type: 3,
    to: WALLV2,
    data,
    chainId: 42,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerBlobGas,
    gasLimit: 200_000n,
    blobs: [blobHex],
    kzg,
  };

  console.log('\nsending Type-3 blob tx…');
  const sent = await z.sendTransaction(tx);
  console.log('tx hash:', sent.hash, '\n' + EXPLORER + '/tx/' + sent.hash);
  const rcpt = await sent.wait();
  console.log('mined in block', rcpt.blockNumber, '| status', rcpt.status, '| gasUsed', rcpt.gasUsed.toString());
  if (rcpt.blobGasUsed !== undefined) console.log('blobGasUsed', rcpt.blobGasUsed?.toString(), '| blobGasPrice', rcpt.blobGasPrice?.toString());

  // --- read the event back + assert ---
  const parsed = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const ev = parsed.find((p) => p.name === 'PostedBlob');
  if (!ev) throw new Error('PostedBlob event not found in receipt');
  const anchored = ev.args.blobHash;
  console.log('\nPostedBlob id', ev.args.id.toString(), 'from', ev.args.from, 'anchored blobHash', anchored);
  if (anchored.toLowerCase() !== versionedHash.toLowerCase()) {
    throw new Error(`ANCHOR MISMATCH: event ${anchored} != computed ${versionedHash}`);
  }
  console.log('\n✅ SPIKE PASS: Type-3 blob tx accepted on LUKSO mainnet; contract bound blobhash(0) == our versioned hash; body rode in the blob (ephemeral), hash anchored on-chain (permanent).');

  fs.writeFileSync(path.join(__dirname, 'blob-spike-result.json'), JSON.stringify({
    ok: true, txHash: sent.hash, block: rcpt.blockNumber, versionedHash,
    postedBlobId: ev.args.id.toString(), payloadBytes: payload.length,
    gasUsed: rcpt.gasUsed.toString(),
    blobGasUsed: rcpt.blobGasUsed?.toString() ?? null,
    blobGasPrice: rcpt.blobGasPrice?.toString() ?? null,
    when: new Date().toISOString(),
  }, null, 2));
}
main().catch((e) => { console.error('\n❌ SPIKE FAIL:', e?.shortMessage || e?.message || e); if (e?.info) console.error('info:', JSON.stringify(e.info).slice(0, 500)); process.exit(1); });
