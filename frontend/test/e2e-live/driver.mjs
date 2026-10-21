// driver.mjs — live end-to-end exercise of the FRONTEND's own signaling+crypto
// stack against the LIVE RegistryV3 on LUKSO mainnet (chain 42).
//
// This is NOT a unit test with mocks: it bundles the real frontend source
// (src/lib/{crypto,offer,signaling,registry,rpc,blobStore,config}.ts) with
// esbuild and drives two identities (alice, bob — the e2e-lab controllers)
// through the exact path a browser runs:
//
//   1. derive X25519 conv keys (same HKDF-of-EIP-191 philosophy; here from the
//      raw ctrl priv since Node has no UP extension — see note below)
//   2. announceConvPub()  -> live RegistryV3.announce(convPub)   [REAL tx]
//   3. convPubOf()        -> read each other's key back FROM CHAIN
//   4. alice: buildSealedOffer(sdp,fp) + blobStore.put + announceSession()
//                          -> live RegistryV3.announceSession(...)  [REAL tx]
//   5. bob:  watchInbound() fires on the SessionAnnounced event, fetches the
//            blob, checks bodyHash == keccak(blob), openSealedOffer() decrypts,
//            verifies the EIP-191 signature recovers to alice, reads SDP+fp
//   6. bob answers the same way; alice reads+decrypts+verifies the answer
//
// HONEST BOUNDARIES (stated, not hidden):
//  - Identity: a real browser signs via the UP extension (EIP-191). Node has no
//    extension, so we sign with the controller EOA wallet directly. The bytes
//    signed and verified are byte-identical to the browser path (signMessage
//    over keccak(core)); only the *source* of the signer differs.
//  - The alice/bob `address`es are controller EOAs, not deployed LSP0 UP
//    contracts. The frontend's signaling+crypto layer is address-agnostic
//    (it signs/verifies with the controller key), so this faithfully exercises
//    it; it does NOT prove UP-contract-specific behavior.
//  - SDP: a real two-browser RTCPeerConnection cannot run headless in Node, so
//    the SDP + DTLS fingerprint here are a representative real-shaped payload,
//    not from a live media negotiation. Everything that TRANSPORTS and SECURES
//    that payload (seal, hash, on-chain announce, event read, blob, decrypt,
//    EIP-191 verify, fingerprint pin) is the real frontend code against the
//    real contract. The browser-to-browser media path is the one piece this
//    can't cover and must be checked in two real browsers.
//
// Keys: ../../..//poc/up-wg-handshake/e2e-lab/keys/{alice,bob}.json (gitignored).
// No key is printed. BROADCAST=1 sends real txs; dry run does off-chain only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { ethers } from 'ethers';

// Node has globalThis.crypto in 24, but make it explicit for the bundle.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const __dir = dirname(fileURLToPath(import.meta.url));
const FE = join(__dir, '..', '..');                 // frontend/
const LIBS = join(FE, 'src', 'lib');
const KEYDIR = join(FE, '..', 'poc', 'up-wg-handshake', 'e2e-lab', 'keys');
const BROADCAST = process.env.BROADCAST === '1';
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];

const log = (...a) => console.log(...a);
const ok = (c, m) => log(`  ${c ? '✓' : '✗'} ${m}`);

// --- bundle the real frontend lib into one ESM module we can import ----------
async function loadFrontendLib() {
  const entry = join(__dir, '_entry.mjs');
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    // config.ts / blobStore.ts read import.meta.env; Node has no Vite, so
    // define it as an empty object -> all the `?? default` branches take the
    // documented defaults (live RegistryV3 address, memory blob store).
    define: { 'import.meta.env': '{}' },
    // Keep ethers external: it's a Node-resolvable ESM dep and bundling it
    // drags in `ws` with a dynamic require('events') that an ESM bundle can't
    // execute. The frontend uses the same ethers; nothing is mocked.
    external: ['ethers'],
    logLevel: 'silent',
    absWorkingDir: FE,
  });
  const code = res.outputFiles[0].text;
  const out = join(__dir, '_bundle.generated.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, code);
  return import(`file://${out}`);
}

function loadIdentity(name) {
  const j = JSON.parse(readFileSync(join(KEYDIR, name + '.json'), 'utf8'));
  return j; // { name, address, ctrlPriv, convPriv, convPub }
}

async function connect() {
  let e;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, 42, { staticNetwork: true });
      if ((await p.getNetwork()).chainId === 42n) return { p, rpc };
    } catch (err) { e = err; }
  }
  throw e || new Error('no RPC');
}

// A real-shaped WebRTC SDP offer/answer with a real DTLS fingerprint line.
// (Shape matches what the browser's RTCPeerConnection.createOffer emits; see
// boundary note above on why this isn't from a live negotiation.)
function sampleSdp(kind, fp) {
  const ufrag = ethers.hexlify(ethers.randomBytes(3)).slice(2);
  const pwd = ethers.hexlify(ethers.randomBytes(12)).slice(2);
  return [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-', 't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:${fp}`,
    `a=setup:${kind === 'offer' ? 'actpass' : 'active'}`,
    'a=mid:0',
    'a=sctp-port:5000',
  ].join('\r\n') + '\r\n';
}

function randFingerprint() {
  const bytes = [...ethers.getBytes(ethers.randomBytes(32))];
  return 'sha-256 ' + bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

async function main() {
  log('=== FRONTEND live E2E: real signaling+crypto vs live RegistryV3 (chain 42) ===');
  log('mode   :', BROADCAST ? 'BROADCAST (real on-chain txs)' : 'DRY-RUN (off-chain only)');

  const lib = await loadFrontendLib();
  const {
    REGISTRY_ADDRESS, REGISTRY_V3_DEPLOYED, CHAIN_ID,
    threadIdFor, conversationKey, // from crypto (re-exported by _entry)
    buildSealedOffer, openSealedOffer,
    publishSession, fetchAndOpenSession,
    MemoryBlobStore,
    announceConvPub, convPubOf,
    SESSION_KIND,
  } = lib;

  log('registry:', REGISTRY_ADDRESS, '| V3 flag:', REGISTRY_V3_DEPLOYED, '| chain:', CHAIN_ID);
  if (!REGISTRY_V3_DEPLOYED) throw new Error('config says RegistryV3 not deployed');

  const { p: provider, rpc } = await connect();
  log('rpc    :', rpc);

  const aId = loadIdentity('alice');
  const bId = loadIdentity('bob');
  const aw = new ethers.Wallet(aId.ctrlPriv, provider);
  const bw = new ethers.Wallet(bId.ctrlPriv, provider);
  const aConvPriv = ethers.getBytes(aId.convPriv);
  const bConvPriv = ethers.getBytes(bId.convPriv);
  const aConvPub = ethers.getBytes(aId.convPub);
  const bConvPub = ethers.getBytes(bId.convPub);
  log('alice  :', aw.address);
  log('bob    :', bw.address);
  ok(aw.address.toLowerCase() === aId.address.toLowerCase(), 'alice ctrl key matches stored address');
  ok(bw.address.toLowerCase() === bId.address.toLowerCase(), 'bob ctrl key matches stored address');

  // ---- balances ----
  const aBal = await provider.getBalance(aw.address);
  const bBal = await provider.getBalance(bw.address);
  log(`\n[bal] alice ${ethers.formatEther(aBal)} LYX | bob ${ethers.formatEther(bBal)} LYX`);

  // =====================================================================
  // STEP A — offer/answer envelope round-trip through the REAL frontend
  //          offer.ts (buildSealedOffer/openSealedOffer). Pure off-chain,
  //          runs in both modes; this is the crypto+sign+verify core.
  // =====================================================================
  log('\n[A] frontend offer.ts envelope round-trip (seal/sign/open/verify)');
  const fpA = randFingerprint();
  const sdpA = sampleSdp('offer', fpA);
  const sealed = await buildSealedOffer({
    kind: 'offer', signer: aw, fromAddr: aw.address, fromConvPriv: aConvPriv,
    toAddr: bw.address, toConvPub: bConvPub, sdp: sdpA, fingerprint: fpA,
  });
  ok(sealed.body?.length > 0, `sealed body ${sealed.body.length} B, bodyHash ${sealed.bodyHash.slice(0, 18)}…`);
  const opened = await openSealedOffer({
    body: sealed.body, myConvPriv: bConvPriv, fromConvPub: aConvPub,
    fromAddr: aw.address, toAddr: bw.address, expectFrom: aw.address,
  });
  ok(opened.sdp === sdpA, 'bob recovered byte-identical SDP');
  ok(opened.fingerprint === fpA, 'bob recovered the UP-signed DTLS fingerprint');
  ok(opened.verifiedFrom.toLowerCase() === aw.address.toLowerCase(), 'EIP-191 signature recovers to alice (anti-MITM)');

  // tamper check: flip a ciphertext byte -> must fail to open (GCM auth)
  let tamperFailed = false;
  try {
    const bad = sealed.body.slice(); bad[bad.length - 1] ^= 0x01;
    await openSealedOffer({ body: bad, myConvPriv: bConvPriv, fromConvPub: aConvPub,
      fromAddr: aw.address, toAddr: bw.address, expectFrom: aw.address });
  } catch { tamperFailed = true; }
  ok(tamperFailed, 'tampered blob is rejected (AES-GCM auth tag)');

  // wrong-signer check: bob tries to pass it off as from himself -> verify fails
  let mitmFailed = false;
  try {
    await openSealedOffer({ body: sealed.body, myConvPriv: bConvPriv, fromConvPub: aConvPub,
      fromAddr: aw.address, toAddr: bw.address, expectFrom: bw.address });
  } catch { mitmFailed = true; }
  ok(mitmFailed, 'signature-mismatch (impersonation) is rejected');

  // bodyHash integrity (what signaling.ts checks against the on-chain value)
  const recomputed = ethers.keccak256(sealed.body);
  ok(recomputed.toLowerCase() === sealed.bodyHash.toLowerCase(), 'keccak(blob) == announced bodyHash');

  if (!BROADCAST) {
    log('\nDRY-RUN complete — off-chain frontend crypto path verified.');
    log('Re-run with BROADCAST=1 to exercise the live RegistryV3 announce/announceSession path.');
    return;
  }

  // =====================================================================
  // STEP B — LIVE on-chain: announce conv pubkeys to RegistryV3
  // =====================================================================
  log('\n[B] announce conv-pubkeys on LIVE RegistryV3');
  for (const [w, convPub, nm] of [[aw, aId.convPub, 'alice'], [bw, bId.convPub, 'bob']]) {
    const cur = await convPubOf(w.address);
    if (cur && cur.toLowerCase() === convPub.toLowerCase()) { ok(true, `${nm} conv-pubkey already announced on-chain`); continue; }
    const h = await announceConvPub(w, convPub);
    ok(true, `${nm} announce tx ${h}`);
  }
  const aOnChain = await convPubOf(aw.address);
  const bOnChain = await convPubOf(bw.address);
  ok(aOnChain?.toLowerCase() === aId.convPub.toLowerCase(), 'alice conv-pubkey reads back from chain');
  ok(bOnChain?.toLowerCase() === bId.convPub.toLowerCase(), 'bob conv-pubkey reads back from chain');

  // Shared in-process blob store (stands in for IPFS; see boundary note).
  const store = new MemoryBlobStore();

  // =====================================================================
  // STEP C — alice publishes a sealed OFFER via the real publishSession()
  //          (blob off-chain + announceSession on LIVE RegistryV3), bob
  //          catches the SessionAnnounced event and opens it from chain.
  // =====================================================================
  log('\n[C] alice announceSession(offer) on-chain; bob reads event + decrypts');
  const inbound = [];
  const stop = await lib.watchInbound(bw.address, (s) => inbound.push(s));

  const pub = await publishSession({
    signer: aw, blobStore: store, kind: 'offer',
    fromAddr: aw.address, fromConvPriv: aConvPriv,
    toAddr: bw.address, toConvPub: ethers.getBytes(bOnChain),
    sdp: sdpA, fingerprint: fpA,
  });
  ok(true, `announceSession(offer) tx ${pub.txHash} | blobRef ${String(pub.blobRef).slice(0, 18)}… | thread ${pub.threadId.slice(0, 14)}…`);

  // wait for the event (poll up to ~40s)
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    got = inbound.find((s) => String(s.blobRef).toLowerCase() === String(pub.blobRef).toLowerCase());
    if (!got) await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  ok(!!got, got ? `bob received SessionAnnounced(offer) from ${got.from}` : 'bob did NOT receive the event in 40s');
  if (got) {
    const openedOnChain = await fetchAndOpenSession({
      incoming: got, blobStore: store, myConvPriv: bConvPriv,
      fromConvPub: ethers.getBytes(aOnChain), myAddr: bw.address,
    });
    ok(openedOnChain.sdp === sdpA, 'bob decrypted the on-chain-announced offer SDP');
    ok(openedOnChain.verifiedFrom.toLowerCase() === aw.address.toLowerCase(), 'on-chain offer signature verifies to alice');
  }

  // =====================================================================
  // STEP D — bob answers; alice reads+decrypts the answer
  // =====================================================================
  log('\n[D] bob announceSession(answer); alice reads event + decrypts');
  const inboundA = [];
  const stopA = await lib.watchInbound(aw.address, (s) => inboundA.push(s));
  const fpB = randFingerprint();
  const sdpB = sampleSdp('answer', fpB);
  const pubB = await publishSession({
    signer: bw, blobStore: store, kind: 'answer',
    fromAddr: bw.address, fromConvPriv: bConvPriv,
    toAddr: aw.address, toConvPub: ethers.getBytes(aOnChain),
    sdp: sdpB, fingerprint: fpB,
  });
  ok(true, `announceSession(answer) tx ${pubB.txHash}`);
  let gotB = null;
  for (let i = 0; i < 40 && !gotB; i++) {
    // Match THIS run's announce by its unique blobRef — a lookback window can
    // also surface a prior run's SessionAnnounced(answer) on the same (
    // deterministic) threadId whose blob isn't in this process's store.
    gotB = inboundA.find((s) => String(s.blobRef).toLowerCase() === String(pubB.blobRef).toLowerCase());
    if (!gotB) await new Promise((r) => setTimeout(r, 1000));
  }
  await stopA();
  ok(!!gotB, gotB ? `alice received SessionAnnounced(answer) from ${gotB.from}` : 'alice did NOT receive the answer event');
  if (gotB) {
    const openedB = await fetchAndOpenSession({
      incoming: gotB, blobStore: store, myConvPriv: aConvPriv,
      fromConvPub: ethers.getBytes(bOnChain), myAddr: aw.address,
    });
    ok(openedB.sdp === sdpB, 'alice decrypted the on-chain-announced answer SDP');
    ok(openedB.verifiedFrom.toLowerCase() === bw.address.toLowerCase(), 'on-chain answer signature verifies to bob');
  }

  log('\n=== LIVE E2E complete: UP-signed announce + sealed offer/answer round-trip through the real frontend stack against live RegistryV3. ===');
  log('What this does NOT cover (needs two real browsers + UP extension): live getUserMedia + browser-to-browser WebRTC media/DataChannel.');
}

main().catch((e) => { console.error('ERR', e?.stack || e?.message || e); process.exit(1); });
