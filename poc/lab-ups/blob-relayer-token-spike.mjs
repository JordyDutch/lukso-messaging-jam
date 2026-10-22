// blob-relayer-token-spike.mjs — SPIKE: the forked tools-mock-relayer
// (server/antica) blob-relay loop, token-metered with DAWG (LSP7).
//
// Proves the FULL ecosystem flow B sketched, end to end on LUKSO mainnet:
//   1. charger station: mint 10 DAWG to a user UP (the "come in, get 10 dawgs").
//   2. user approves ALL dawgs to the relayer operator ONCE
//      (UP.execute(authorizeOperator) via LSP25 — the extension can sign this).
//   3. relayer /execute replays tools-mock-relayer handleExecute +
//      handleExecutionChargeback EXACTLY, with the ONE fork: it builds the outer
//      tx as EIP-4844 Type-3 (blobs+kzg) when the payload is a postBlob, so the
//      blob rides along and `blobhash(0)` binds 3 frames deep. On success it
//      debits 1 DAWG (transfer(up -> operator, 1)). 1 DAWG == 1 blob post.
//   4. NEGATIVE: the UNMODIFIED stock relayer builds a Type-2 tx (no blob) — we
//      show that exact path reverts BlobHashMismatch. This is how a current UP
//      relayer "breaks" the blob lane, which is what we want to surface.
//
// The relayer code touched: src/modules/relayer/relayer.service.ts
//   handleExecute()           -> signTransaction({to, transactionData, gasLimit})  (Type-2)  [FORK -> Type-3]
//   handleExecutionChargeback -> getOperatorsOf / authorizedAmountFor / transfer(from,to,1,false,txHash)
//   src/modules/quota/quota.service.ts getAuthorizedAmountFor/balanceOf (quota gate).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const POC = '/home/bk/.openclaw/workspace/lukso-jam-messaging/poc';
const { ethers } = require(POC + '/node_modules/ethers');
const { loadKZG } = require(POC + '/node_modules/kzg-wasm');
const solc = require(POC + '/node_modules/solc');

const EL = 'https://rpc.mainnet.lukso.network';
const CL = 'https://rpc.mainnet.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const LSP25_VERSION = 25;
const CHAIN_ID = 42;

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- blob codec + versioned hash (same bytes as the proven spikes) --------
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

// ---- LSP25 digest (EIP-191 v0, PACKED) — identical to blob-lsp25-spike ----
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
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

function compileDawg() {
  const src = fs.readFileSync(path.join(__dirname, 'DawgToken.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'DawgToken.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('DAWG compile failed'); }
  const c = out.contracts['DawgToken.sol']['DawgToken'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// Build the controller-signed executeRelayCall calldata for a postBlob through the UP.
async function buildRelayCalldata({ km, kmAddr, ctrl, blobHash, meta }) {
  const wall = new ethers.Interface(WALL_ABI);
  const up = new ethers.Interface(UP_ABI);
  const postBlobData = wall.encodeFunctionData('postBlob', [ethers.ZeroAddress, false, ethers.ZeroHash, blobHash, meta]);
  const payload = up.encodeFunctionData('execute', [0, WALLV2, 0, postBlobData]);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const digest = lsp25Digest(kmAddr, nonce, 0n, 0n, payload);
  const sig = ctrl.signingKey.sign(digest).serialized; // raw EIP-191 v0 hash
  const kmIface = new ethers.Interface(KM_ABI);
  const outerData = kmIface.encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  return { outerData, nonce };
}

async function main() {
  console.log('=== SPIKE: token-metered (DAWG/LSP7) blob relayer — forked tools-mock-relayer — MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');
  const reader = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  const kzg = await loadKZG();

  // relayer EOA = the LSP15 service SIGNER_PRIVATE_KEY (pays gas, is the operator).
  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const aliceKm = ethers.getAddress(st.alice.kmAddress);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey);
  const OPERATOR_UP = relayer.address; // fee recipient (treasury). EOA is fine for the spike.

  console.log('relayer/operator EOA :', relayer.address, ethers.formatEther(await provider.getBalance(relayer.address)), 'LYX');
  console.log('user UP (alice)      :', aliceUp, ' KeyManager', aliceKm, ' controller', aliceCtrl.address, '\n');

  const km = new ethers.Contract(aliceKm, KM_ABI, provider);
  const wall = new ethers.Interface(WALL_ABI);
  const out = { network: 'lukso-mainnet', steps: {} };

  // ---- STEP 1: charger station — deploy DAWG + mint 10 to the user UP -------
  console.log('[1] charger station: deploy DAWG (LSP7) + mint 10 to user UP');
  const { abi: DAWG_ABI, bytecode } = compileDawg();
  const factory = new ethers.ContractFactory(DAWG_ABI, bytecode, relayer);
  const dawg = await factory.deploy();
  await dawg.waitForDeployment();
  const dawgAddr = await dawg.getAddress();
  console.log('    DAWG token:', dawgAddr);
  const GRANT = 10n;
  await (await dawg.mint(aliceUp, GRANT)).wait();
  const bal0 = await dawg.balanceOf(aliceUp);
  console.log('    minted; user DAWG balance =', bal0.toString());
  out.steps.charger = { dawg: dawgAddr, grant: GRANT.toString(), userBalance: bal0.toString() };

  // ---- STEP 2: user approves ALL dawgs to the relayer operator, ONCE --------
  // authorizeOperator(operator=relayer, amount=balance, data="") via UP.execute
  // through LSP25 (the signature the UP extension CAN produce).
  console.log('\n[2] user authorizes operator for all DAWG (UP.execute -> authorizeOperator, LSP25-signed)');
  const dawgIface = new ethers.Interface(DAWG_ABI);
  const authData = dawgIface.encodeFunctionData('authorizeOperator', [relayer.address, bal0, '0x']);
  const upExecAuth = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, dawgAddr, 0, authData]);
  {
    const nonce = await km.getNonce(aliceCtrl.address, 0n);
    const digest = lsp25Digest(aliceKm, nonce, 0n, 0n, upExecAuth);
    const sig = aliceCtrl.signingKey.sign(digest).serialized;
    const outerData = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, upExecAuth]);
    const fee = await provider.getFeeData();
    const tx = await relayer.sendTransaction({ to: aliceKm, data: outerData, chainId: CHAIN_ID, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit: 300000n });
    const r = await tx.wait();
    console.log('    authorizeOperator relayed, tx', tx.hash, 'status', r.status);
  }
  const approved = await dawg.authorizedAmountFor(relayer.address, aliceUp);
  const ops = await dawg.getOperatorsOf(aliceUp);
  console.log('    authorizedAmountFor(operator,user) =', approved.toString(), ' operators:', ops);
  out.steps.authorize = { approved: approved.toString(), operators: ops };
  if (approved !== bal0) throw new Error('FAIL: authorization amount != balance');

  // ---- STEP 3: relayer /execute (quota gate + FORK: Type-3) + chargeback ----
  console.log('\n[3] relayer /execute: quota gate -> build Type-3 (FORK) -> postBlob -> debit 1 DAWG');

  // quota gate (quota.service.getAuthorizedAmountFor / balanceOf)
  const quota = await dawg.balanceOf(aliceUp);
  const authFor = await dawg.authorizedAmountFor(relayer.address, aliceUp);
  console.log('    quota: balance', quota.toString(), 'authorizedToOperator', authFor.toString());
  if (authFor === 0n) throw new Error('UPGRADE_REQUIRED (no approved DAWG) — relayer would 426 here');

  // build the blob + the controller-signed relay calldata
  const body = enc.encode(`DAWG-metered blob post, author=alice UP — ${new Date().toISOString()}`);
  const blobHex = '0x' + Buffer.from(encodeBlob(body)).toString('hex');
  const blobHash = versionedHashOfBlob(kzg, blobHex);
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length, via: 'dawg-relayer' }));
  const { outerData } = await buildRelayCalldata({ km, kmAddr: aliceKm, ctrl: aliceCtrl, blobHash, meta });

  // handleExecute FORK: the stock service does signTransaction(Type-2); here we
  // attach the blob and send Type-3. Everything else (to=KeyManager, calldata=
  // executeRelayCall) is byte-identical to the unmodified relayer.
  const fee = await provider.getFeeData();
  const tx = await relayer.sendTransaction({
    type: 3, to: aliceKm, data: outerData, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
    gasLimit: 600000n, blobs: [blobHex], kzg,
  });
  console.log('    outer Type-3 tx:', tx.hash);
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => { try { return wall.parseLog(l); } catch { return null; } }).filter(Boolean).find((p) => p.name === 'PostedBlob');
  if (!ev) throw new Error('FAIL: no PostedBlob — relay or blob binding failed');
  const from = ethers.getAddress(ev.args.from);
  const fromIsUp = from === aliceUp;
  console.log('    PostedBlob id', ev.args.id.toString(), 'from', from, 'fromIsUserUP', fromIsUp, 'gasUsed', rcpt.gasUsed.toString());
  const got = dec.decode(await fetchBlobBody(reader, tx.hash, blobHash));
  const okBody = got === dec.decode(body);
  console.log('    beacon-recovered body match:', okBody);
  if (!fromIsUp) throw new Error('FAIL: PostedBlob.from != user UP');
  if (!okBody) throw new Error('FAIL: body mismatch');

  // handleExecutionChargeback: operator pulls 1 DAWG from the user UP.
  await (await dawg.transfer(aliceUp, OPERATOR_UP, 1n, false, tx.hash)).wait();
  const balAfter = await dawg.balanceOf(aliceUp);
  const opBal = await dawg.balanceOf(OPERATOR_UP);
  console.log('    chargeback: user DAWG', bal0.toString(), '->', balAfter.toString(), ' operator DAWG', opBal.toString());
  out.steps.execute = { txHash: tx.hash, postedBlobId: ev.args.id.toString(), from, fromIsUp, blobHash, bodyRecovered: okBody, gasUsed: rcpt.gasUsed.toString(), userBalanceAfter: balAfter.toString(), operatorBalance: opBal.toString() };
  if (balAfter !== bal0 - 1n) throw new Error('FAIL: chargeback did not debit exactly 1 DAWG');

  // ---- STEP 4: NEGATIVE — the UNMODIFIED stock relayer (Type-2, no blob) -----
  // THE REAL BREAK. WallV2.postBlob DELIBERATELY allows blobhash(0)==0 (the
  // "hash-only, body pinned off-chain" mode, WallV2.sol:94-111). So a stock
  // Type-2 relayer does NOT revert — it SUCCEEDS on-chain, anchors the hash,
  // and (with metering) would charge the DAWG. The failure is silent: because
  // no blob was ever attached to the tx, the body is UNRECOVERABLE from the
  // beacon. User pays, post exists, content is gone. That is how a current UP
  // relayer "breaks" the blob lane — not a revert, a lost payload.
  console.log('\n[4] NEGATIVE: stock relayer builds Type-2 (no blob) -> post succeeds on-chain but body is IRRECOVERABLE');
  const body2 = enc.encode(`stock-relayer attempt (no blob) — ${new Date().toISOString()}`);
  const blobHex2 = '0x' + Buffer.from(encodeBlob(body2)).toString('hex');
  const blobHash2 = versionedHashOfBlob(kzg, blobHex2);
  const { outerData: outer2 } = await buildRelayCalldata({ km, kmAddr: aliceKm, ctrl: aliceCtrl, blobHash: blobHash2, meta });
  const fee2 = await provider.getFeeData();
  const stockTx = await relayer.sendTransaction({
    to: aliceKm, data: outer2, chainId: CHAIN_ID, type: 2,
    maxFeePerGas: fee2.maxFeePerGas, maxPriorityFeePerGas: fee2.maxPriorityFeePerGas, gasLimit: 300000n,
  });
  const stockRcpt = await stockTx.wait();
  const stockEv = stockRcpt.logs.map((l) => { try { return new ethers.Interface(WALL_ABI).parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'PostedBlob');
  const stockPosted = stockRcpt.status === 1 && !!stockEv;
  // the on-chain anchor is the hash of a blob that was never carried -> beacon
  // has nothing for this tx. Confirm the body is NOT recoverable.
  let bodyLost = true;
  try { const b = await fetchBlobBody(reader, stockTx.hash, stockEv.args.blobHash); bodyLost = !b; }
  catch { bodyLost = true; }
  console.log('    stock Type-2 post on-chain:', stockPosted, 'id', stockEv ? stockEv.args.id.toString() : 'n/a',
    '| body recoverable from beacon:', !bodyLost, '(expected false)');
  out.steps.negativeStockRelayer = {
    type: 2, blobAttached: false, reverts: false,
    postSucceededOnChain: stockPosted, postedId: stockEv ? stockEv.args.id.toString() : null,
    bodyRecoverable: !bodyLost, tx: stockTx.hash,
    break: 'Type-2 relay anchors the hash and charges the user, but no blob is attached so the body is irrecoverable (silent data loss).',
  };

  // PASS = fork loop works (Type-3, from=UP, body recovered, exactly 1 DAWG
  // debited) AND the stock Type-2 path demonstrably loses the body.
  out.verdict = (fromIsUp && okBody && balAfter === bal0 - 1n && stockPosted && bodyLost) ? 'PASS' : 'FAIL';
  out.forkPoint = 'relayer.service.ts handleExecute: signTransaction(Type-2) -> sendTransaction({type:3, blobs, kzg}) when payload targets postBlob';
  out.contractChangeToWallV2 = false;
  out.relayerBase = 'm8b-dev/tools-mock-relayer @ server/antica (LSP15 + LSP7 TokenQuotaTransactionsCount)';
  fs.writeFileSync(path.join(__dirname, 'blob-relayer-token-spike-result.json'), JSON.stringify(out, null, 2));
  console.log('\n' + (out.verdict === 'PASS' ? '✅' : '❌'), 'VERDICT:', out.verdict, '— wrote blob-relayer-token-spike-result.json');
  if (out.verdict !== 'PASS') process.exit(1);
}

main().catch((e) => { console.error('\n❌ SPIKE FAILED:', e.shortMessage || e.message || e); process.exit(1); });
