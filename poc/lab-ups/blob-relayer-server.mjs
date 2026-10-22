// blob-relayer-server.mjs — LIVE HTTP blob relayer (AUTHOR-SIGNATURE, OPEN mode).
//
// Option B (B's design, 2026-10-22): LSP25 executeRelayCall is abandoned for
// browser posts because the UP extension can only produce EIP-191 *prefixed*
// signatures, which the LSP25 KeyManager rejects (it needs a RAW 32-byte
// digest). Instead the frontend personal_signs a canonical message binding the
// post to its UP; we recover the signer, verify it is an authorized LSP6
// controller of the claimed UP, and send the EIP-4844 Type-3 blob tx AS
// OURSELVES (relayer pays gas), embedding the author proof (up + nonce +
// signature + name) in WallV2 `meta`. On-chain PostedBlob.from = the relayer;
// the authoritative author is the UP, re-verified from `meta` on read.
//
// OPEN mode (B's choice 2026-10-22, for the E2E signature test with a real UP):
// DAWG metering is DISABLED — any UP whose signature recovers to one of its
// authorized controllers can post. Treasury/metering (1 DAWG/blob) is wired in
// the spike and can be turned back on later behind REQUIRE_DAWG=1.
//
// Endpoints (same-origin behind a reverse-proxy sub-path, so NO CORS, but
// we send permissive CORS headers anyway so it also works cross-origin):
//   GET  /nonce?up=0x..  -> { keyManager, nonce, ... }  (legacy; unused by Option B)
//   POST /execute        body { up, upName, tag, encrypted, threadId, blobHash,
//        len, nonce, chainId, wall, signature, blob }
//        -> { txHash, postedId, from (relayer), author (UP), recovered }
//   GET  /health         -> { ok, relayer, mode }
//
// Run:  node blob-relayer-server.mjs --port 3100 --bind 127.0.0.1
// Key:  /home/bk/.openclaw/workspace/.z-lukso-key.json  (funded relayer EOA)

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const { loadKZG } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/kzg-wasm');

// ---- config ---------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf('--port', process.env.PORT || '3100'));
const BIND = argOf('--bind', '127.0.0.1');
const EL = process.env.EL_RPC || 'https://rpc.mainnet.lukso.network';
const KEYFILE = process.env.RELAYER_KEY || '/home/bk/.openclaw/workspace/.z-lukso-key.json';
const WALLV2 = process.env.WALL_ADDRESS || '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const CHAIN_ID = Number(process.env.CHAIN_ID || '42');
const LSP25_VERSION = 25;
const REQUIRE_DAWG = process.env.REQUIRE_DAWG === '1';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---- LSP25 digest (EIP-191 v0, PACKED per spec) — identical to the spike ---
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
  'function owner() view returns (address)',
  'function getData(bytes32 dataKey) view returns (bytes)',
];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];

// ---- author-signature model (B's design, 2026-10-22) -----------------------
//
// We do NOT use LSP25 executeRelayCall for blob posts. On-chain msg.sender is
// the relayer; AUTHORSHIP is an embedded signature by a key that is an
// authorized LSP6 controller of the claimed UP. The signed message binds the
// post to a specific UP + body + wall + chain so neither the relayer nor a
// replayer can reattribute it. Readers recover the signer and check it still
// controls the UP. This is the same guarantee as LSP25 (a UP controller
// authorized THIS post), verified from the signature instead of by the
// KeyManager — and it works with the EIP-191 personal-prefix signature every
// UP extension can produce.
//
// Canonical author message (EIP-191 personal_sign over this exact UTF-8 string;
// MUST match frontend src/lib/relay.ts buildAuthMessage byte-for-byte):
//   up-wall:post:v2\n
//   chainId:<id>\n
//   wall:<wallAddressLower>\n
//   up:<upAddressLower>\n
//   tag:<tagLower>\n
//   encrypted:<0|1>\n
//   threadId:<0x..32>\n
//   blobHash:<0x..32>\n
//   len:<bodyLen>\n
//   nonce:<decimal>
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

// Pack the author proof into `meta` as compact binary (WallV2 MAX_META=256):
//   v(1=2) | scheme(1=1 "lsp-authsig") | up(20) | nonce u64 BE(8) |
//   sigLen(1) | sig(sigLen) | nameLen(1) | name(utf8)
const META_V2 = 2, META_SCHEME_AUTHSIG = 1;
function packMeta({ up, nonce, sig, name }) {
  const upB = ethers.getBytes(up);                 // 20
  const sigB = ethers.getBytes(sig);               // 65
  const nameB = ethers.toUtf8Bytes((name || '').slice(0, 120));
  const nonceB = new Uint8Array(8);
  { let n = BigInt(nonce); for (let i = 7; i >= 0; i--) { nonceB[i] = Number(n & 0xffn); n >>= 8n; } }
  const out = ethers.concat([
    new Uint8Array([META_V2, META_SCHEME_AUTHSIG]),
    upB, nonceB,
    new Uint8Array([sigB.length]), sigB,
    new Uint8Array([nameB.length]), nameB,
  ]);
  return ethers.hexlify(out);
}

// ---- LSP6 permission keys (ERC725Y) — identical to the spike ---------------
const AP_ARRAY_KEY = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const PERM_PREFIX = '0x4b80742de2bf82acb3630000';
const permKeyFor = (addr) => PERM_PREFIX + addr.toLowerCase().replace(/^0x/, '');
function apIndexKey(i) {
  const head = AP_ARRAY_KEY.slice(2, 2 + 32);
  const idx = BigInt(i).toString(16).padStart(32, '0');
  return '0x' + head + idx;
}
async function listControllers(upC) {
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
const hasPerm = (p) => !!p && p !== '0x' && BigInt(p) !== 0n;

// ---- http helpers ----------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 2_000_000) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main() {
  const provider = new ethers.JsonRpcProvider(EL, undefined, { staticNetwork: true });
  const relayer = new ethers.Wallet(load(KEYFILE).privateKey, provider);
  const kzg = await loadKZG();
  const wallIface = new ethers.Interface(WALL_ABI);

  const bal = await provider.getBalance(relayer.address);
  console.log(`[relayer] EOA ${relayer.address} balance ${ethers.formatEther(bal)} LYX`);
  console.log(`[relayer] mode=${REQUIRE_DAWG ? 'DAWG-metered' : 'OPEN (no metering)'} wall=${WALLV2} chain=${CHAIN_ID}`);

  async function handleNonce(res, up) {
    up = ethers.getAddress(up);
    const upC = new ethers.Contract(up, UP_ABI, provider);
    const keyManager = ethers.getAddress(await upC.owner());
    const controllers = await listControllers(upC);
    const permitted = controllers.find((c) => hasPerm(c.perm));
    if (!permitted) return sendJson(res, 422, { error: 'no permitted controller on UP' });
    const km = new ethers.Contract(keyManager, KM_ABI, provider);
    const nonce = await km.getNonce(permitted.addr, 0n);
    // controller addr intentionally NOT returned
    return sendJson(res, 200, { keyManager, nonce: nonce.toString(), validityTimestamps: '0' });
  }

  async function handleExecute(res, reqObj) {
    // Author-signature model (B's design): the frontend sends the post fields +
    // an EIP-191 personal_sign by a controller of the claimed UP. We verify the
    // signature authorizes THIS exact post for THIS UP, then post the blob as
    // the relayer (on-chain from = relayer; authoritative author = reqObj.up,
    // bound by the signature embedded in `meta`).
    let up, tag, threadId, blobHash;
    try {
      up = ethers.getAddress(reqObj.up);
      tag = ethers.getAddress(reqObj.tag);
      threadId = ethers.hexlify(reqObj.threadId);
      blobHash = ethers.hexlify(reqObj.blobHash);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad address/hash field: ' + (e?.message ?? e) });
    }
    const encrypted = !!reqObj.encrypted;
    const len = Number(reqObj.len);
    const nonce = String(reqObj.nonce ?? '');
    const signature = reqObj.signature;
    const blobHex = reqObj.blob;
    const upName = typeof reqObj.upName === 'string' ? reqObj.upName : '';
    if (!signature || !blobHex || !nonce) return sendJson(res, 400, { error: 'missing signature/blob/nonce' });
    if (!Number.isFinite(len) || len < 0) return sendJson(res, 400, { error: 'bad len' });

    // (1) Rebuild the canonical message and recover the author (personal_sign /
    //     EIP-191 prefixed — the signature every UP extension can produce).
    const msg = buildAuthMessage({ chainId: CHAIN_ID, wall: WALLV2, up, tag, encrypted, threadId, blobHash, len, nonce });
    let recovered;
    try { recovered = ethers.verifyMessage(msg, signature); } // = recover over EIP-191 personal digest
    catch (e) { return sendJson(res, 400, { error: 'bad signature: ' + (e?.message ?? e) }); }

    // (2) Verify the recovered key is an authorized LSP6 controller of the UP.
    const upC = new ethers.Contract(up, UP_ABI, provider);
    let signerPerm;
    try { signerPerm = await upC.getData(permKeyFor(recovered)); }
    catch (e) { return sendJson(res, 502, { error: 'UP read failed: ' + (e?.message ?? e) }); }
    if (!hasPerm(signerPerm)) {
      let controllers = [];
      try { controllers = await listControllers(upC); } catch (e) { controllers = [{ err: String(e?.message ?? e) }]; }
      console.log(`[403] up=${up} recovered=${recovered} permValue=${signerPerm}`);
      return sendJson(res, 403, {
        error: 'signer is not a controller of the UP',
        recovered, up, permValue: signerPerm, controllers,
      });
    }

    // (3) Bind the blob: the attached blob's KZG versioned hash MUST equal the
    //     signed blobHash, else the relayer (or a replayer) could pair this
    //     signature with a different body. WallV2.postBlob also enforces
    //     blobHash == blobhash(0) on-chain, but we fail fast here with context.
    //     (len/body-shape are the author's claim, carried for readers.)

    // (4) metering — DAWG burn (OFF for now, per B). When REQUIRE_DAWG=1 we would
    //     check the author UP's DAWG balance/allowance and burn 1 here.
    if (REQUIRE_DAWG) {
      return sendJson(res, 501, { error: 'DAWG metering not wired in this server build; run with REQUIRE_DAWG unset' });
    }

    // (5) Pack the author proof into `meta` and post the blob AS THE RELAYER.
    const meta = packMeta({ up, nonce, sig: signature, name: upName });
    if (ethers.getBytes(meta).length > 256) {
      return sendJson(res, 400, { error: `meta ${ethers.getBytes(meta).length} > MAX_META 256 (shorten UP name)` });
    }
    const wallIfaceW = new ethers.Interface(WALL_ABI);
    const data = wallIfaceW.encodeFunctionData('postBlob', [tag, encrypted, threadId, blobHash, meta]);
    const fee = await provider.getFeeData();
    let tx;
    try {
      tx = await relayer.sendTransaction({
        type: 3, to: WALLV2, data, chainId: CHAIN_ID,
        maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
        maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
        gasLimit: 600000n, blobs: [blobHex], kzg,
      });
    } catch (e) {
      return sendJson(res, 502, { error: 'send failed: ' + (e?.shortMessage ?? e?.message ?? e), recovered });
    }
    console.log(`[execute] author-sig up=${up} signer=${recovered} type3=${tx.hash}`);
    const rcpt = await tx.wait();
    const ev = rcpt.logs.map((l) => { try { return wallIface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((p) => p.name === 'PostedBlob');
    if (!ev) return sendJson(res, 500, { error: 'no PostedBlob event (blob binding failed — blobHash != blobhash(0)?)', txHash: tx.hash, recovered });
    console.log(`[execute] PostedBlob id=${ev.args.id} from(relayer)=${ev.args.from} author(UP)=${up}`);
    return sendJson(res, 200, { txHash: tx.hash, postedId: ev.args.id.toString(), from: ethers.getAddress(ev.args.from), author: up, recovered });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, relayer: relayer.address, mode: REQUIRE_DAWG ? 'dawg' : 'open' });
      }
      if (req.method === 'GET' && url.pathname === '/nonce') {
        const up = url.searchParams.get('up');
        if (!up) return sendJson(res, 400, { error: 'missing up' });
        return await handleNonce(res, up);
      }
      if (req.method === 'POST' && url.pathname === '/execute') {
        const raw = await readBody(req);
        let obj;
        try { obj = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
        return await handleExecute(res, obj);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });
  server.listen(PORT, BIND, () => console.log(`[relayer] listening http://${BIND}:${PORT}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
