// p2p-answerer.mjs — headless "alice" that ANSWERS an off-chain P2P call placed
// from a real browser (frontend2 P2pPanel "Go off-chain").
//
// It mirrors frontend2/src/lib/p2p.ts byte-for-byte on the wire:
//   - watches Wall for an inbound P2P-signal DM (body prefixed ASCII "p2p1:")
//     addressed to alice from the caller,
//   - opens + verifies the sealed+signed offer envelope with alice's conv key,
//   - builds a REAL WebRTC answer via @roamhq/wrtc (Node has no browser WebRTC),
//   - seals+signs the answer envelope and posts it back as an encrypted Wall DM
//     via UP.execute -> Wall.post,
//   - and holds the RTCPeerConnection so the DataChannel actually connects; it
//     echoes anything the caller sends and sends a greeting on open.
//
// Usage: node p2p-answerer.mjs [callerUP]   (default = B's UP 0x0C0F…B355)
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import { ethers } from 'ethers';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const { RTCPeerConnection } = wrtc;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const WALL = '0xd3a767c7fE981524810aF7bdE05FA6537B96f58E';
const REGISTRY = '0x01AC2FE086C2D69923F199d47C85688aB2FA088c';
const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const CALLER = ethers.getAddress(process.argv[2] || '0x0C0F2EF398512d2Bef043D7DF882ec91a91fB355');

const KIND_OFFER = 0x01, KIND_ANSWER = 0x02;
const P2P_MAGIC = new TextEncoder().encode('p2p1:');
const TTL = 600;
const enc = new TextEncoder(), dec = new TextDecoder();
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const UP_ABI = [
  'function execute(uint256,address,uint256,bytes) payable returns (bytes)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
];
const ERC1271_MAGIC = '0x1626ba7e';
const REG_ABI = ['function convPubOf(address) view returns (bytes32)'];
const WALL_ABI = [
  'function post(address tag, bool encrypted, bytes32 threadId, bytes body)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
];

// ---- crypto (1:1 with frontend2) ----
function concatB(...a) { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; }
async function deriveConv(wallet) {
  const sig = await wallet.signMessage(CONV_KEY_DOMAIN);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const convPriv = hkdf(sha256, ethers.getBytes(sig), salt, enc.encode('x25519-conv-v1'), 32);
  return { convPriv, convPub: x25519.getPublicKey(convPriv) };
}
function threadIdFor(a, b) { const [lo, hi] = [a, b].map((x) => ethers.getAddress(x)).sort(); return ethers.keccak256(ethers.concat([ethers.zeroPadValue(lo, 32), ethers.zeroPadValue(hi, 32)])); }
function conversationKey(myPriv, peerPub, threadId) { const shared = x25519.getSharedSecret(myPriv, peerPub); const salt = ethers.getBytes(ethers.keccak256(ethers.getBytes(threadId))); return hkdf(sha256, shared, salt, enc.encode('up-chat-v1'), 32); }
const MAGIC = Uint8Array.from([0x45, 0xe2]);
async function seal(buf, key) { const iv = webcrypto.getRandomValues(new Uint8Array(12)); const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']); const s = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, buf)); return concatB(MAGIC, iv, s.subarray(s.length - 16), s.subarray(0, s.length - 16)); }
async function open(body, key) { const iv = body.subarray(2, 14), tag = body.subarray(14, 30), ct = body.subarray(30); const ck = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']); return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, concatB(ct, tag))); }

// ---- SDP compact/restore (1:1 with frontend2/src/lib/sdp.ts) ----
const DEF_SCTP = '5000', DEF_MAXMSG = '262144';
function parseSdp(sdp) {
  const g = (re) => { const m = sdp.match(re); if (!m) throw new Error('SDP missing ' + re); return m[1]; };
  const candidates = [];
  for (const line of sdp.split(/\r?\n/)) { const m = line.match(/^a=(candidate:.+)$/); if (m) candidates.push(m[1].trim()); }
  return { fingerprint: g(/a=fingerprint:(.+)/), setup: g(/a=setup:(\S+)/), iceUfrag: g(/a=ice-ufrag:(\S+)/), icePwd: g(/a=ice-pwd:(\S+)/), mid: (sdp.match(/a=mid:(\S+)/) ?? [, '0'])[1], candidates };
}
const candAddr = (c) => (c.split(/\s+/)[4] ?? '');
const isIpv6 = (c) => candAddr(c).includes(':');
const isMdns = (c) => candAddr(c).endsWith('.local');
const isLoopback = (c) => { const a = candAddr(c); return a === '127.0.0.1' || a === '::1'; };
function pickCandidates(cands) { const udp = cands.filter((c) => /\budp\b/i.test(c) && !isIpv6(c) && !isLoopback(c) && !isMdns(c)); const hosts = udp.filter((c) => /typ host/.test(c)); hosts.sort((a, b) => (candAddr(a).startsWith('10.8.') ? -1 : 0) - (candAddr(b).startsWith('10.8.') ? -1 : 0)); const srflx = udp.find((c) => /typ srflx/.test(c)); const out = [...hosts.slice(0, 2), srflx].filter(Boolean); return out.length ? out : udp.slice(0, 2); }
function compact(sdp) {
  const p = parseSdp(sdp); const cands = pickCandidates(p.candidates);
  const lines = [`F${p.fingerprint}`, `S${p.setup}`, `U${p.iceUfrag}`, `P${p.icePwd}`, `M${p.mid}`, ...cands.map((c) => `C${c}`)];
  const sctp = sdp.match(/a=sctp-port:(\S+)/)?.[1]; const maxMsg = sdp.match(/a=max-message-size:(\S+)/)?.[1];
  if (sctp && sctp !== DEF_SCTP) lines.push(`Z${sctp}`); if (maxMsg && maxMsg !== DEF_MAXMSG) lines.push(`X${maxMsg}`);
  return lines.join('\n');
}
function restore(rec) {
  const f = {}; const cands = [];
  for (const line of rec.split(/\r?\n/)) { if (!line) continue; const tag = line[0], val = line.slice(1); if (tag === 'C') cands.push(val); else f[tag] = val; }
  const sctp = f.Z ?? DEF_SCTP, maxMsg = f.X ?? DEF_MAXMSG, mid = f.M ?? '0';
  return ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${mid}`, 'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...cands.map((c) => `a=${c}`), `a=ice-ufrag:${f.U}`, `a=ice-pwd:${f.P}`, 'a=ice-options:trickle', `a=fingerprint:${f.F}`, `a=setup:${f.S}`, `a=mid:${mid}`, `a=sctp-port:${sctp}`, `a=max-message-size:${maxMsg}`].join('\r\n') + '\r\n';
}
const u16be = (n) => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
const expiryBytes = (s) => ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(s), 5));
function fingerprintFromSdp(sdp) { const m = sdp.match(/a=fingerprint:(\S+)\s+(\S+)/i); if (!m) throw new Error('no fp'); return `${m[1]} ${m[2]}`; }
function startsWithMagic(b) { if (b.length < P2P_MAGIC.length) return false; for (let i = 0; i < P2P_MAGIC.length; i++) if (b[i] !== P2P_MAGIC[i]) return false; return true; }

async function connect() { for (const r of RPCS) { try { const p = new ethers.JsonRpcProvider(r); if ((await p.getNetwork()).chainId === 42n) { console.log('RPC', r); return p; } } catch {} } throw new Error('no rpc'); }
async function feeOf(p) { const f = await p.getFeeData(); return (f.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n; }
async function getLogsChunked(c, filt, from, to) { const out = []; for (let lo = from; lo <= to; lo += 1000) { out.push(...await c.queryFilter(filt, lo, Math.min(lo + 999, to))); } return out; }
async function upExecute(ctrl, p, upAddr, target, data, label) {
  const up = new ethers.Contract(upAddr, UP_ABI, ctrl);
  const calldata = up.interface.encodeFunctionData('execute', [0, target, 0, data]);
  const tx = { to: upAddr, data: calldata, nonce: await p.getTransactionCount(ctrl.address, 'pending'), gasPrice: await feeOf(p) };
  tx.gasLimit = (await p.estimateGas({ ...tx, from: ctrl.address })) * 130n / 100n;
  const t = await ctrl.sendTransaction(tx);
  console.log(`  ${label}: ${EXPLORER}/tx/${t.hash}`);
  await p.waitForTransaction(t.hash, 1, 180_000);
  return t.hash;
}

async function iceComplete(pc) { if (pc.iceGatheringState === 'complete') return; await new Promise((r) => { const c = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', c); r(); } }; pc.addEventListener('icegatheringstatechange', c); setTimeout(r, 5000); }); }

async function main() {
  const p = await connect();
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const ctrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, p);
  const { convPriv, convPub } = await deriveConv(ctrl);

  const reg = new ethers.Contract(REGISTRY, REG_ABI, p);
  const onchain = await reg.convPubOf(aliceUp);
  if (onchain.toLowerCase() !== ethers.hexlify(convPub).toLowerCase())
    throw new Error(`alice derived convPub != on-chain announce (${onchain})`);
  const callerPubHex = await reg.convPubOf(CALLER);
  if (/^0x0*$/.test(callerPubHex)) throw new Error('caller has not announced a conv-pub');
  const callerPub = ethers.getBytes(callerPubHex);
  const threadId = threadIdFor(aliceUp, CALLER);
  const key = conversationKey(convPriv, callerPub, threadId);

  console.log('alice UP', aliceUp, '\ncaller  ', CALLER, '\nthread  ', threadId.slice(0, 18) + '…');
  console.log('waiting for your browser P2P offer (Go off-chain → alice)…\n');

  const wall = new ethers.Contract(WALL, WALL_ABI, p);
  const wallIface = new ethers.Interface(WALL_ABI);
  const seen = new Set();
  let answered = false;
  let pc, channel;

  async function handleOffer(offerBody) {
    // A new offer supersedes any prior (stale) call — tear the old peer down so
    // we always answer the latest offer the browser is actually driving.
    if (pc) { try { pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicecandidate = pc.ondatachannel = null; pc.close(); } catch {} pc = null; channel = null; }
    // open + verify signed envelope
    const sealed = offerBody.subarray(P2P_MAGIC.length);
    const payload = await open(sealed, key);
    const sig = ethers.hexlify(payload.subarray(payload.length - 65));
    const core = payload.subarray(0, payload.length - 65);
    // The caller UP is a contract: its controller EOA signs (signMessage over
    // keccak(core)). Authenticity = ERC-1271 isValidSignature on the caller UP
    // over the EIP-191-prefixed hash that was actually signed.
    const innerHash = ethers.getBytes(ethers.keccak256(core));
    const recovered = ethers.verifyMessage(innerHash, sig);
    const eip191Hash = ethers.hashMessage(innerHash);
    const callerUp = new ethers.Contract(CALLER, UP_ABI, p);
    const res = await callerUp.isValidSignature(eip191Hash, sig).catch(() => '0x');
    if (String(res).toLowerCase() !== ERC1271_MAGIC)
      throw new Error(`sig not from a controller of ${CALLER} (MITM?) recovered=${recovered} res=${res}`);
    console.log(`  signer ${recovered} is an authorized controller of caller UP ✓`);
    let o = 0; const kind = core[o++]; const fpLen = core[o++]; const fp = dec.decode(core.subarray(o, o + fpLen)); o += fpLen;
    const expiry = Number('0x' + ethers.hexlify(core.subarray(o, o + 5)).slice(2)); o += 5;
    const sdpLen = (core[o] << 8) | core[o + 1]; o += 2;
    const offerSdp = restore(dec.decode(core.subarray(o, o + sdpLen)));
    if (kind !== KIND_OFFER) { console.log('  (not an offer, ignoring)'); return; }
    if (expiry < Math.floor(Date.now() / 1000)) throw new Error('offer expired');
    console.log(`✓ verified offer from caller. pinned DTLS fp: ${fp.slice(0, 28)}…`);
    console.log('  offer candidates from browser:');
    for (const ln of offerSdp.split(/\r?\n/)) if (ln.startsWith('a=candidate:')) console.log('    ' + ln.slice(2));

    // build REAL answer. Handlers reference THIS peer (`me`), never the shared
    // module `pc`, so a superseded peer's late events can't deref a nulled `pc`.
    const me = new RTCPeerConnection({ iceServers: ICE });
    pc = me;
    me.onconnectionstatechange = () => console.log('  [pc]', me.connectionState);
    me.oniceconnectionstatechange = () => console.log('  [ice]', me.iceConnectionState);
    me.onicecandidate = (e) => { if (e.candidate) console.log('  [cand]', e.candidate.candidate); };
    me.ondatachannel = (e) => {
      const ch = e.channel; channel = ch;
      ch.onopen = () => { console.log('\n⚡ DataChannel OPEN — off-chain link established. Sending greeting.'); ch.send('alice here, off-chain over WebRTC 👋 (no chain from here on)'); };
      ch.onmessage = (ev) => {
        const msg = String(ev.data);
        console.log('  ← caller:', msg);
        // alice replies conversationally to whatever B typed in the browser.
        const reply = `alice ↩ heard you say "${msg}" — loud and clear over the off-chain channel at ${new Date().toLocaleTimeString()}. No chain touched. 🛰️`;
        try { ch.send(reply); } catch (e) { console.log('  send failed:', e.message); }
      };
    };
    await me.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const ans = await me.createAnswer(); await me.setLocalDescription(ans); await iceComplete(me);
    const ansSdp = (me.localDescription && me.localDescription.sdp) || ans.sdp;
    if (!ansSdp) throw new Error('no local answer SDP (peer torn down?)');
    console.log('  alice answer candidates (gathered):');
    for (const ln of ansSdp.split(/\r?\n/)) if (ln.startsWith('a=candidate:')) console.log('    ' + ln.slice(2));
    console.log('  alice answer candidates (after compaction):');
    for (const ln of restore(compact(ansSdp)).split(/\r?\n/)) if (ln.startsWith('a=candidate:')) console.log('    [kept] ' + ln.slice(2));

    // seal + sign answer, post as DM
    const ansFp = fingerprintFromSdp(ansSdp);
    const fpb = enc.encode(ansFp); const sdpb = enc.encode(compact(ansSdp));
    const exp = Math.floor(Date.now() / 1000) + TTL;
    const core2 = concatB(Uint8Array.from([KIND_ANSWER]), Uint8Array.from([fpb.length]), fpb, expiryBytes(exp), u16be(sdpb.length), sdpb);
    const sig2 = await ctrl.signMessage(ethers.getBytes(ethers.keccak256(core2)));
    const payload2 = concatB(core2, ethers.getBytes(sig2));
    const sealed2 = await seal(payload2, key);
    const body2 = concatB(P2P_MAGIC, sealed2);
    console.log(`  answer envelope ${body2.length} B (cap 1024); posting as encrypted DM…`);
    const data = wallIface.encodeFunctionData('post', [CALLER, true, threadId, body2]);
    await upExecute(ctrl, p, aliceUp, WALL, data, 'alice → caller P2P answer');
    answered = true;
    console.log('  answer on-chain. your browser should now connect the DataChannel.\n');
  }

  const head0 = await p.getBlockNumber();
  // prime seen with existing posts so we only react to NEW offers (but still
  // catch a very recent one): look back a small window.
  const tick = async () => {
    try {
      const head = await p.getBlockNumber();
      const logs = await getLogsChunked(wall, wall.filters.Posted(null, CALLER, aliceUp), Math.max(0, head - 1000), head);
      // Collect NEW signaling posts in this batch, then process only the single
      // newest one — overlapping offers must not race each other's teardown.
      const fresh = [];
      for (const l of logs.sort((a, b) => Number(a.args.id) - Number(b.args.id))) {
        const idk = `${l.transactionHash}:${l.index}`;
        if (seen.has(idk)) continue; seen.add(idk);
        if (!l.args.encrypted) continue;
        const body = ethers.getBytes(l.args.body);
        if (!startsWithMagic(body)) continue;
        if (l.args.threadId.toLowerCase() !== threadId.toLowerCase()) continue;
        fresh.push({ id: Number(l.args.id), body, blk: l.blockNumber });
      }
      // Once a DataChannel is live, ignore further signaling (don't drop the call).
      const live = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
      if (live || fresh.length === 0) return;
      const latest = fresh[fresh.length - 1];
      console.log(`\n⚡ inbound P2P signal post #${latest.id} (${latest.body.length} B) blk ${latest.blk}` +
        (fresh.length > 1 ? ` (newest of ${fresh.length}; older offers skipped)` : ''));
      await handleOffer(latest.body).catch((e) => console.error('  handleOffer FAIL:', e.message));
    } catch (e) { /* transient rpc */ }
  };
  // keep polling; stay alive to hold the DataChannel. Exit after 4 min idle post-answer.
  let elapsed = 0;
  const iv = setInterval(async () => {
    await tick();
    elapsed += 4;
    const live = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
    if (live) { elapsed = 0; return; } // connected — stay up indefinitely to hold the channel
    if (answered && elapsed > 900) { console.log('idle timeout (never connected), closing.'); clearInterval(iv); pc?.close(); process.exit(0); }
    if (!answered && elapsed > 600) { console.log('no offer in 10 min, giving up.'); clearInterval(iv); process.exit(1); }
  }, 4000);
  await tick();
  void head0;
}
main().catch((e) => { console.error('FATAL:', e.message || e); process.exit(1); });
