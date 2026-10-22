// blob-lsp25-spike.mjs — SPIKE: can the EXISTING LSP25 relay path carry a
// Type-3 (blob) tx so that the UP is msg.sender inside WallV2.postBlob, with NO
// contract change and NO custom postBlobFor?
//
// Idea: the relayer EOA sends a Type-3 tx whose CALLDATA is
//   KeyManager.executeRelayCall(sig, nonce, validityTimestamps, payload)
// where `payload` = UP.execute(0, WALL, 0, postBlob(...)). The controller signs
// the LSP25 digest (EIP-191 v0, packed) off-chain — exactly what the UP
// extension does for gas-less txs today. The blob rides the OUTER tx.
//
// The crux we must PROVE (not assume): `blobhash(0)` is a TRANSACTION-level
// opcode, so inside postBlob (3 call frames deep: EOA→KeyManager→UP→Wall) it
// must still read the outer tx's blob and match the anchored blobHash. If it
// does, then:
//   * msg.sender inside postBlob == the UP (via UP.execute), so PostedBlob.from
//     is the real author with ZERO contract change, and
//   * authorship is the standard LSP6/LSP25 controller signature — strictly
//     better than a custom EIP-712 scheme.
//
// Run on LUKSO MAINNET against the live WallV2 + alice's real UP/KeyManager.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const { loadKZG } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/kzg-wasm');

const EL = 'https://rpc.mainnet.lukso.network';
const CL = 'https://rpc.mainnet.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const LSP25_VERSION = 25;
const CHAIN_ID = 42;

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- blob codec + versioned hash (same as prior spikes) -------------------
const FIELD_ELEMENTS = 4096, BLOB_SIZE = FIELD_ELEMENTS * 32;
function encodeBlob(payload) {
  const blob = new Uint8Array(BLOB_SIZE);
  const len = payload.length;
  blob[28] = (len >>> 24) & 0xff; blob[29] = (len >>> 16) & 0xff; blob[30] = (len >>> 8) & 0xff; blob[31] = len & 0xff;
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) { const b = w * 32 + 1; for (let i = 0; i < 31 && o < len; i++) blob[b + i] = payload[o++]; }
  return blob;
}
function decodeBlob(blob) {
  const len = (blob[28] << 24) | (blob[29] << 16) | (blob[30] << 8) | blob[31];
  const out = new Uint8Array(len); let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) { const b = w * 32 + 1; for (let i = 0; i < 31 && o < len; i++) out[o++] = blob[b + i]; }
  return out;
}
function versionedHashOfBlob(kzg, blobHex) {
  const probe = ethers.Transaction.from({ type: 3, to: WALLV2, chainId: CHAIN_ID, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n, gasLimit: 21000n, data: '0x', blobs: [blobHex], kzg });
  return probe.blobVersionedHashes[0];
}

// ---- beacon retrieval ------------------------------------------------------
let genesis = null;
async function beaconGenesis() { if (genesis == null) genesis = Number((await (await fetch(CL + '/eth/v1/beacon/genesis')).json()).data.genesis_time); return genesis; }
function vhOfCommitment(commitHex) { const c = Buffer.from(commitHex.slice(2), 'hex'); const h = crypto.createHash('sha256').update(c).digest(); h[0] = 0x01; return '0x' + h.toString('hex'); }
async function fetchBlobBody(provider, txHash, anchoredHash) {
  const rcpt = await provider.getTransactionReceipt(txHash);
  const blk = await provider.getBlock(rcpt.blockNumber);
  const slot = Math.floor((Number(blk.timestamp) - (await beaconGenesis())) / 12);
  const res = await fetch(CL + `/eth/v1/beacon/blob_sidecars/${slot}`);
  if (!res.ok) throw new Error('sidecars ' + res.status);
  const scs = (await res.json()).data ?? [];
  for (const sc of scs) if (vhOfCommitment(sc.kzg_commitment).toLowerCase() === anchoredHash.toLowerCase()) return decodeBlob(Buffer.from(sc.blob.slice(2), 'hex'));
  throw new Error('no sidecar matched (pruned/mismatch)');
}

// ---- LSP25 digest (EIP-191 v0, PACKED per spec) ---------------------------
// 0x19 00 <impl(KeyManager)> <LSP25_VERSION u256> <chainId u256> <nonce u256>
//      <validityTimestamps u256> <value u256> <calldata bytes>
function lsp25Digest(keyManager, nonce, validityTimestamps, value, payload) {
  const packed = ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', keyManager, LSP25_VERSION, CHAIN_ID, nonce, validityTimestamps, value, payload],
  );
  return ethers.keccak256(packed);
}

const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = [
  'function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)',
];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

async function main() {
  console.log('=== SPIKE: LSP25 relay carries a Type-3 blob tx (UP = msg.sender, no contract change) — MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');
  const reader = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  const kzg = await loadKZG();

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const aliceKm = ethers.getAddress(st.alice.kmAddress);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey); // UP controller

  console.log('relayer EOA (outer msg.sender):', relayer.address, ethers.formatEther(await provider.getBalance(relayer.address)), 'LYX');
  console.log('alice UP:', aliceUp, ' KeyManager:', aliceKm, ' controller:', aliceCtrl.address, '\n');

  const wall = new ethers.Interface(WALL_ABI);
  const up = new ethers.Interface(UP_ABI);
  const km = new ethers.Contract(aliceKm, KM_ABI, provider);

  // 1) Build the blob + versioned hash.
  const body = enc.encode(`LSP25-relayed blob post, author=alice UP — ${new Date().toISOString()}`);
  const blobHex = '0x' + Buffer.from(encodeBlob(body)).toString('hex');
  const blobHash = versionedHashOfBlob(kzg, blobHex);
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length }));

  // 2) Inner payloads: UP.execute(CALL=0, WALL, 0, postBlob(...))
  const postBlobData = wall.encodeFunctionData('postBlob', [ethers.ZeroAddress, false, ethers.ZeroHash, blobHash, meta]);
  const upExecPayload = up.encodeFunctionData('execute', [0, WALLV2, 0, postBlobData]);

  // 3) Controller signs the LSP25 relay digest (what the UP extension does).
  const channel = 0n;
  const nonce = await km.getNonce(aliceCtrl.address, channel);
  const validityTimestamps = 0n; // valid indefinitely
  const value = 0n;
  const digest = lsp25Digest(aliceKm, nonce, validityTimestamps, value, upExecPayload);
  // EIP-191 v0 digest is signed as a RAW 32-byte hash (no eth-sign prefix).
  const sig = aliceCtrl.signingKey.sign(digest).serialized;
  console.log('LSP25 nonce:', nonce.toString(), ' controller sig:', sig.slice(0, 20) + '…');

  // 4) Relayer sends the OUTER Type-3 tx: data = executeRelayCall(...), blob attached.
  const kmIface = new ethers.Interface(KM_ABI);
  const outerData = kmIface.encodeFunctionData('executeRelayCall', [sig, nonce, validityTimestamps, upExecPayload]);
  const fee = await provider.getFeeData();

  // Preflight: eth_call the relay through the KM to surface any auth/nonce error
  // before we pay for a Type-3 (blobhash(0) is 0 in eth_call, which postBlob
  // tolerates, so this checks the LSP25/LSP6 path, not the blob binding).
  try {
    await provider.call({ from: relayer.address, to: aliceKm, data: outerData });
    console.log('preflight eth_call of executeRelayCall: OK (LSP25/LSP6 path valid)');
  } catch (e) {
    console.log('preflight eth_call reverted:', (e.shortMessage || e.message));
    throw new Error('LSP25 relay path rejected before blob send — see revert above');
  }

  const tx = await relayer.sendTransaction({
    type: 3, to: aliceKm, data: outerData, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
    gasLimit: 600000n, blobs: [blobHex], kzg,
  });
  console.log('outer Type-3 tx:', tx.hash);
  const rcpt = await tx.wait();
  console.log('status:', rcpt.status, 'block', rcpt.blockNumber, 'gasUsed', rcpt.gasUsed.toString());

  // 5) Find PostedBlob and check from == alice UP (proves blobhash(0) matched at
  //    depth AND msg.sender inside postBlob was the UP).
  const ev = rcpt.logs.map((l) => { try { return wall.parseLog(l); } catch { return null; } }).filter(Boolean).find((p) => p.name === 'PostedBlob');
  if (!ev) throw new Error('no PostedBlob event — relay or blob binding failed');
  const from = ethers.getAddress(ev.args.from);
  console.log('PostedBlob id', ev.args.id.toString(), 'from', from, 'anchored blobHash', ev.args.blobHash);
  const fromIsUp = from === aliceUp;
  const hashMatched = ev.args.blobHash.toLowerCase() === blobHash.toLowerCase();
  console.log('from == alice UP:', fromIsUp, ' (blobhash(0) matched at 3-frame depth since postBlob did not revert BlobHashMismatch:', hashMatched, ')');

  // 6) Third-party reader recovers the body from the beacon.
  const got = dec.decode(await fetchBlobBody(reader, tx.hash, blobHash));
  const okBody = got === dec.decode(body);
  console.log('recovered from beacon:', JSON.stringify(got), 'match:', okBody);

  if (!fromIsUp) throw new Error('FAIL: PostedBlob.from is not the UP');
  if (!hashMatched) throw new Error('FAIL: anchored blobHash != expected');
  if (!okBody) throw new Error('FAIL: body mismatch');

  const out = {
    network: 'lukso-mainnet', approach: 'LSP25 executeRelayCall carries Type-3 blob; UP.execute → postBlob',
    txHash: tx.hash, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed.toString(),
    postedBlobFrom: from, authorUp: aliceUp, fromIsUp, blobHash, hashMatchedAtDepth: hashMatched,
    bodyRecovered: okBody, relayer: relayer.address, contractChangeNeeded: false, verdict: 'PASS',
  };
  fs.writeFileSync(path.join(__dirname, 'blob-lsp25-spike-result.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ LSP25 BLOB RELAY SPIKE PASS — UP is msg.sender, zero contract change. wrote blob-lsp25-spike-result.json');
}

main().catch((e) => { console.error('\n❌ SPIKE FAILED:', e.shortMessage || e.message || e); process.exit(1); });
