// blob-sigrelay-spike.mjs — SPIKE: B's signature-based blob relayer split.
//
// Architecture under test (B, 2026-10-22):
//   "use normal relayer for smart-contract calls, and in-frontend use a relayer
//    for relaying the blobs — the frontend sends the controller SIGNATURE to the
//    relayer; the backend determines all the validation ifs and whom to charge."
//
// The correction baked in here: a dApp driven by the UP extension CANNOT get the
// controller private key, and CANNOT even name the controller address (the
// extension returns the UP address and abstracts the controller). So the only
// thing the frontend can hand over is an LSP25 relay SIGNATURE over the
// executeRelayCall digest (the same signature the extension already makes for
// gas-less meta-txs). EVERYTHING else is the backend's job.
//
// This spike therefore proves the BACKEND can, from {up, signature, nonce,
// payload, blob} ALONE (never the controller address, never a key):
//   (B1) RECOVER the controller EOA from the LSP25 signature (ecrecover on the
//        EIP-191 v0 digest) — i.e. learn "who signed" without being told.
//   (B2) VALIDATE that recovered signer is an authorized LSP6 controller of the
//        claimed UP, by reading ERC725Y AddressPermissions on-chain.
//   (B3) DETERMINE whom to charge + charge them (DAWG/LSP7 metering).
//   (B4) SEND the Type-3 blob tx via the UNMODIFIED KeyManager.executeRelayCall.
//   (NEG) REJECT a signature from a non-controller (e.g. bob's key for alice's UP).
//
// The /nonce round-trip: the backend needs getNonce(controller, channel) and the
// frontend can't name the controller. Resolved here exactly as the real backend
// would: backend reads the UP's controllers from AddressPermissions[] and uses
// the blob-permitted one. (The frontend sent only `up`.)
//
// Run on LUKSO MAINNET against live WallV2 + alice/bob real UPs.

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
  // ERC725Y getData for AddressPermissions
  'function getData(bytes32 dataKey) view returns (bytes)',
  'function getDataBatch(bytes32[] dataKeys) view returns (bytes[])',
];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

// ---- LSP6 permission keys (ERC725Y) ---------------------------------------
// AddressPermissions[]  = 0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3
// AddressPermissions[index] element key = first 16 bytes of the array key + 16-byte index
// AddressPermissions:Permissions:<address> = 0x4b80742de2bf82acb3630000 ++ address
const AP_ARRAY_KEY = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const PERM_PREFIX = '0x4b80742de2bf82acb3630000';
function permKeyFor(addr) { return PERM_PREFIX + addr.toLowerCase().replace(/^0x/, ''); }
function apIndexKey(i) {
  const head = AP_ARRAY_KEY.slice(2, 2 + 32); // first 16 bytes (32 hex)
  const idx = BigInt(i).toString(16).padStart(32, '0'); // 16-byte index
  return '0x' + head + idx;
}

// BACKEND: from the UP address alone, list controllers + their permission words.
async function backendListControllers(upC) {
  const lenHex = await upC.getData(AP_ARRAY_KEY);
  const n = lenHex && lenHex !== '0x' ? Number(BigInt(lenHex)) : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const elem = await upC.getData(apIndexKey(i));
    if (!elem || elem.length < 42) continue;
    const addr = ethers.getAddress('0x' + elem.slice(-40));
    const perm = await upC.getData(permKeyFor(addr));
    out.push({ addr, perm: perm || '0x' });
  }
  return out;
}

async function buildFrontendRequest({ kzg, body, metaObj }) {
  // What the FRONTEND assembles. It knows the UP address and the blob only.
  const blobHex = '0x' + Buffer.from(encodeBlob(body)).toString('hex');
  const blobHash = versionedHashOfBlob(kzg, blobHex);
  const meta = enc.encode(JSON.stringify(metaObj));
  const wall = new ethers.Interface(WALL_ABI);
  const up = new ethers.Interface(UP_ABI);
  const postBlobData = wall.encodeFunctionData('postBlob', [ethers.ZeroAddress, false, ethers.ZeroHash, blobHash, meta]);
  const payload = up.encodeFunctionData('execute', [0, WALLV2, 0, postBlobData]);
  return { blobHex, blobHash, payload };
}

async function main() {
  console.log('=== SPIKE: signature-based blob relayer (frontend sends sig; backend validates + charges) — MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');
  const reader = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  const kzg = await loadKZG();

  // ---- actors ----
  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider); // backend/operator EOA
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const aliceKm = ethers.getAddress(st.alice.kmAddress);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey); // alice's controller (stands in for her extension)
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey);     // an UNRELATED controller (negative case)
  const OPERATOR_UP = relayer.address; // fee recipient (stand-in)

  console.log('backend/relayer EOA :', relayer.address, ethers.formatEther(await provider.getBalance(relayer.address)), 'LYX');
  console.log('user UP (alice)     :', aliceUp, ' KeyManager', aliceKm);
  console.log('  (frontend will send ONLY { up, signature, nonce, payload, blob } — never a controller address/key)\n');

  const out = { network: 'lukso-mainnet', approach: 'frontend LSP25 signature -> backend recover+validate+charge+Type-3', steps: {} };

  // =====================================================================
  //  STEP 0: charger + user approves DAWG once (metering precondition)
  // =====================================================================
  const { abi: DAWG_ABI, bytecode } = (() => {
    const src = fs.readFileSync(path.join(__dirname, 'DawgToken.sol'), 'utf8');
    const solc = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/solc');
    const o = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity', sources: { 'DawgToken.sol': { content: src } },
      settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    })));
    const errs = (o.errors || []).filter((e) => e.severity === 'error');
    if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('DAWG compile failed'); }
    const c = o.contracts['DawgToken.sol']['DawgToken'];
    return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  })();

  console.log('[0] charger: deploy DAWG + mint 10 to user UP; user authorizes operator once');
  const dawg = await new ethers.ContractFactory(DAWG_ABI, bytecode, relayer).deploy();
  await dawg.waitForDeployment();
  const dawgAddr = await dawg.getAddress();
  await (await dawg.mint(aliceUp, 10n)).wait();
  // user authorizeOperator(relayer, 10) via UP.execute + LSP25 (same as before)
  {
    const dawgIface = new ethers.Interface(DAWG_ABI);
    const authData = dawgIface.encodeFunctionData('authorizeOperator', [relayer.address, 10n, '0x']);
    const upExecAuth = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, dawgAddr, 0, authData]);
    const km = new ethers.Contract(aliceKm, KM_ABI, provider);
    const nonce = await km.getNonce(aliceCtrl.address, 0n);
    const digest = lsp25Digest(aliceKm, nonce, 0n, 0n, upExecAuth);
    const sig = aliceCtrl.signingKey.sign(digest).serialized;
    const outerData = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, upExecAuth]);
    const fee = await provider.getFeeData();
    await (await relayer.sendTransaction({ to: aliceKm, data: outerData, chainId: CHAIN_ID, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit: 300000n })).wait();
  }
  const bal0 = await dawg.balanceOf(aliceUp);
  console.log('    DAWG', dawgAddr, 'user balance', bal0.toString(), 'authorized', (await dawg.authorizedAmountFor(relayer.address, aliceUp)).toString());
  out.steps.setup = { dawg: dawgAddr, userBalance: bal0.toString() };

  // =====================================================================
  //  FRONTEND: build request. Knows only the UP address + the blob body.
  // =====================================================================
  const body = enc.encode(`sig-relayed blob, author=alice UP — ${new Date().toISOString()}`);
  const { blobHex, blobHash, payload } = await buildFrontendRequest({ kzg, body, metaObj: { v: 1, len: body.length, via: 'sigrelay' } });

  // =====================================================================
  //  BACKEND /nonce: frontend asks "what nonce do I sign for UP=alice?"
  //  Backend reads the UP's controllers and returns the blob-permitted one's
  //  nonce. The frontend is NEVER told the controller address.
  // =====================================================================
  const upC = new ethers.Contract(aliceUp, UP_ABI, provider);
  const controllers = await backendListControllers(upC);
  console.log('\n[B2a] backend read AddressPermissions[] of UP:', controllers.map((c) => `${c.addr}:${c.perm.slice(0, 10)}…`).join(' '));
  const permitted = controllers.find((c) => c.perm && c.perm !== '0x' && BigInt(c.perm) !== 0n);
  if (!permitted) throw new Error('no permitted controller found on UP');
  const km = new ethers.Contract(aliceKm, KM_ABI, provider);
  const nonce = await km.getNonce(permitted.addr, 0n);
  console.log('    backend picks controller', permitted.addr, 'nonce', nonce.toString(), '(returned to frontend; addr stays backend-side)');

  // =====================================================================
  //  FRONTEND: extension signs the LSP25 digest for that nonce. (We stand in
  //  with alice's controller key; in-browser this is an extension RPC call.)
  //  The frontend posts { up, signature, nonce, validityTimestamps, payload, blob }.
  // =====================================================================
  const digest = lsp25Digest(aliceKm, nonce, 0n, 0n, payload);
  const signature = aliceCtrl.signingKey.sign(digest).serialized;
  const req = { up: aliceUp, signature, nonce, validityTimestamps: 0n, payload, blobHex, blobHash };
  console.log('\n[FE] POST /execute { up, signature:' + signature.slice(0, 14) + '…, nonce:' + nonce + ', payload, blob } (no controller addr)');

  // =====================================================================
  //  BACKEND /execute — ALL the validation ifs + whom to charge.
  // =====================================================================
  // (B1) recover the signer from the LSP25 signature — backend learns "who" from
  //      the signature alone. EIP-191 v0: the digest was signed as a raw hash.
  const reDigest = lsp25Digest(aliceKm, req.nonce, req.validityTimestamps, 0n, req.payload);
  const recovered = ethers.recoverAddress(reDigest, req.signature);
  console.log('\n[B1] backend recovered signer from signature:', recovered);

  // (B2) validate recovered is an authorized LSP6 controller of req.up
  const signerPerm = await upC.getData(permKeyFor(recovered));
  const isController = signerPerm && signerPerm !== '0x' && BigInt(signerPerm) !== 0n;
  console.log('[B2] signer is authorized controller of UP:', isController, '(perm', (signerPerm || '0x').slice(0, 12) + '…)');
  if (!isController) throw new Error('reject: signer is not a controller of the UP');

  // (B3) whom to charge = req.up; check DAWG metering
  const quota = await dawg.balanceOf(req.up);
  const authFor = await dawg.authorizedAmountFor(relayer.address, req.up);
  console.log('[B3] charge target UP', req.up, 'DAWG balance', quota.toString(), 'authorizedToOperator', authFor.toString());
  if (quota === 0n || authFor === 0n) throw new Error('reject: UPGRADE_REQUIRED (no DAWG / not authorized)');

  // (B4) send the Type-3 tx via UNMODIFIED KeyManager.executeRelayCall
  const outerData = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [req.signature, req.nonce, req.validityTimestamps, req.payload]);
  const fee = await provider.getFeeData();
  const tx = await relayer.sendTransaction({
    type: 3, to: aliceKm, data: outerData, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
    gasLimit: 600000n, blobs: [req.blobHex], kzg,
  });
  console.log('[B4] relayer Type-3 tx', tx.hash);
  const rcpt = await tx.wait();
  const wall = new ethers.Interface(WALL_ABI);
  const ev = rcpt.logs.map((l) => { try { return wall.parseLog(l); } catch { return null; } }).filter(Boolean).find((p) => p.name === 'PostedBlob');
  if (!ev) throw new Error('no PostedBlob — relay/blob binding failed');
  const from = ethers.getAddress(ev.args.from);
  const fromIsUp = from === aliceUp;
  const okBody = dec.decode(await fetchBlobBody(reader, tx.hash, req.blobHash)) === dec.decode(body);
  console.log('     PostedBlob id', ev.args.id.toString(), 'from', from, 'fromIsUP', fromIsUp, 'body recovered', okBody);

  // charge 1 DAWG (chargeback)
  await (await dawg.transfer(req.up, OPERATOR_UP, 1n, false, tx.hash)).wait();
  const balAfter = await dawg.balanceOf(req.up);
  console.log('     charged: user DAWG', bal0.toString(), '->', balAfter.toString());
  out.steps.execute = { recoveredSigner: recovered, isController, txHash: tx.hash, postedId: ev.args.id.toString(), from, fromIsUp, bodyRecovered: okBody, userBalanceAfter: balAfter.toString() };

  // =====================================================================
  //  NEGATIVE: a signature from a NON-controller (bob's key) for alice's UP
  //  must be rejected by (B2) before any send. Backend recovers bob, sees no
  //  permission on alice's UP, refuses.
  // =====================================================================
  console.log('\n[NEG] frontend sends bob-signed request for alice UP; backend must reject');
  const nonce2 = await km.getNonce(bobCtrl.address, 0n);
  const digest2 = lsp25Digest(aliceKm, nonce2, 0n, 0n, payload);
  const badSig = bobCtrl.signingKey.sign(digest2).serialized;
  const recovered2 = ethers.recoverAddress(digest2, badSig);
  const perm2 = await upC.getData(permKeyFor(recovered2));
  const rejected = !(perm2 && perm2 !== '0x' && BigInt(perm2) !== 0n);
  console.log('     recovered', recovered2, 'perm on alice UP', (perm2 || '0x').slice(0, 10) + '… -> rejected:', rejected);
  out.steps.negative = { recovered: recovered2, permOnUp: perm2 || '0x', rejected };

  out.verdict = (isController && fromIsUp && okBody && balAfter === bal0 - 1n && rejected) ? 'PASS' : 'FAIL';
  out.contractChangeNeeded = false;
  out.frontendSends = ['up', 'signature', 'nonce', 'validityTimestamps', 'payload', 'blobHex'];
  out.backendDoes = ['recover signer from LSP25 sig', 'validate LSP6 controller via ERC725Y AddressPermissions', 'DAWG balance/allowance', 'send Type-3 executeRelayCall', 'charge 1 DAWG'];
  fs.writeFileSync(path.join(__dirname, 'blob-sigrelay-spike-result.json'), JSON.stringify(out, null, 2));
  console.log('\n' + (out.verdict === 'PASS' ? '✅' : '❌'), 'VERDICT:', out.verdict, '— wrote blob-sigrelay-spike-result.json');
  if (out.verdict !== 'PASS') process.exit(1);
}

main().catch((e) => { console.error('\n❌ SPIKE FAILED:', e.shortMessage || e.message || e); process.exit(1); });
