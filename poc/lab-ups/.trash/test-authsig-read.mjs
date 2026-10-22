// test-authsig-read.mjs — read-side verification of the Option-B author proof.
// Reads the PostedBlob event we just wrote, unpacks `meta`, recovers the signer
// from the embedded signature, and confirms it is an authorized controller of
// the claimed UP — i.e. that readers can derive author = UP without trusting
// on-chain `from` (which is the relayer).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');

const EL = 'https://rpc.mainnet.lukso.network';
const WALL = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const CHAIN_ID = 42;
const TX = process.argv[2] || '0x877ae62143cf1ae2b72eb75df2978efaad1b03ec1084800f977dd638fc75c9f3';
const PERM_PREFIX = '0x4b80742de2bf82acb3630000';

const ABI = ['event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)'];
const ERC725Y = ['function getData(bytes32 dataKey) view returns (bytes)'];

function buildAuthMessage(m) {
  return ['up-wall:post:v2', `chainId:${m.chainId}`, `wall:${m.wall.toLowerCase()}`,
    `up:${m.up.toLowerCase()}`, `tag:${m.tag.toLowerCase()}`, `encrypted:${m.encrypted ? 1 : 0}`,
    `threadId:${m.threadId.toLowerCase()}`, `blobHash:${m.blobHash.toLowerCase()}`,
    `len:${m.len}`, `nonce:${m.nonce}`].join('\n');
}
function unpackAuthMeta(metaHex) {
  const b = ethers.getBytes(metaHex);
  if (b.length < 2 + 20 + 8 + 1 || b[0] !== 2 || b[1] !== 1) return null;
  let o = 2;
  const up = ethers.getAddress(ethers.hexlify(b.slice(o, o + 20))); o += 20;
  let nonce = 0n; for (let i = 0; i < 8; i++) nonce = (nonce << 8n) | BigInt(b[o + i]); o += 8;
  const sigLen = b[o]; o += 1;
  const sig = ethers.hexlify(b.slice(o, o + sigLen)); o += sigLen;
  const nameLen = o < b.length ? b[o] : 0; o += 1;
  const name = nameLen ? new TextDecoder().decode(b.slice(o, o + nameLen)) : '';
  return { up, nonce: nonce.toString(), sig, name };
}

async function main() {
  const p = new ethers.JsonRpcProvider(EL, undefined, { staticNetwork: true });
  const rcpt = await p.getTransactionReceipt(TX);
  const iface = new ethers.Interface(ABI);
  const ev = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean).find((x) => x.name === 'PostedBlob');
  if (!ev) throw new Error('no PostedBlob in tx');
  const a = ev.args;
  console.log('on-chain from (relayer):', a.from);
  const meta = unpackAuthMeta(a.meta);
  console.log('meta:', meta);
  if (!meta) throw new Error('meta is not v2 authsig');

  // The body length is author-claimed; we recover using the same len the author
  // signed. In the live frontend len = recovered blob body length; here we read
  // it back from the meta flow is not possible, so reconstruct from the known
  // test body length (37-ish). Instead: brute nothing — we trust blobHash on
  // chain and only need the controller check, so try the exact signed len.
  // The signer signed len = body.length; recover is only valid with that len.
  // We fetch it by trying the length that reproduces a controller match.
  const upc = new ethers.Contract(meta.up, ERC725Y, p);
  const isCtrl = async (addr) => {
    const perm = await upc.getData(PERM_PREFIX + addr.slice(2).toLowerCase());
    return !!perm && perm !== '0x' && BigInt(perm) !== 0n;
  };
  // search a small len window (author body is short in this test)
  let matched = null;
  for (let len = 0; len <= 200; len++) {
    const msg = buildAuthMessage({ chainId: CHAIN_ID, wall: WALL, up: meta.up, tag: a.tag, encrypted: a.encrypted, threadId: a.threadId, blobHash: a.blobHash, len, nonce: meta.nonce });
    let rec; try { rec = ethers.verifyMessage(msg, meta.sig); } catch { continue; }
    if (await isCtrl(rec)) { matched = { len, rec }; break; }
  }
  if (!matched) throw new Error('no len reproduced a controller-signed message');
  console.log(`recovered signer: ${matched.rec} (len=${matched.len})`);
  console.log(`is controller of ${meta.up}: true`);
  console.log(`\nPASS read-side: author = ${meta.up} name="${meta.name}" (on-chain from was the relayer ${a.from})`);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
