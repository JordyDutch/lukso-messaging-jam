// webrtc-twobrowser.mjs — REAL two-browser WebRTC connect.
//
// Launches TWO real Brave (Chromium) pages via puppeteer with fake media
// devices, and in each page runs the frontend's OWN webrtc.ts (bundled to
// browser ESM by esbuild — nothing mocked). It drives a genuine
// RTCPeerConnection handshake:
//   alice: createPeer -> attachLocalMedia(fake cam/mic) -> makeOffer
//   [SDP offer relayed browser->node->browser, exactly what the on-chain
//    signaling layer carries; that layer is separately proven on live
//    RegistryV3 by driver.mjs]
//   bob:   createPeer -> attachLocalMedia -> makeAnswer
//   alice: applyAnswer
//   ICE candidates trickle both ways via onIceCandidate -> addRemoteIce
//   => DTLS/ICE connect, DataChannel 'text' opens, P2P text crosses both ways.
//
// Honest scope: no UP browser extension in headless Brave (identity is proven
// separately via EIP-191 in driver.mjs); media is --use-fake-device-for-media
// not a real camera. The RTCPeerConnection, ICE/STUN, DTLS and DataChannel are
// 100% real browser WebRTC, browser-to-browser.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from '/home/bk/p/m8b-dev/openscad-host/src/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FE = join(__dir, '..', '..'); // frontend/

// 1) Bundle the real webrtc.ts (+ its config import) to a browser ESM blob.
const entry = join(__dir, '_webrtc_entry.ts');
writeFileSync(
  entry,
  `export * from '${join(FE, 'src/lib/webrtc.ts').replace(/\\/g, '/')}';\n`,
);
const res = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  define: { 'import.meta.env': '{}' },
});
const webrtcBundle = res.outputFiles[0].text;

// 2) Harness page: imports the bundle, exposes window.__wrtc with the lib + a
//    small driver that reports ICE candidates and received messages.
const harnessHtml = `<!doctype html><html><head><meta charset=utf-8></head><body>
<script type=module>
${webrtcBundle}
const api = { makeCertificate, fingerprintFromSdp, createPeer, attachLocalMedia,
  makeOffer, makeAnswer, applyAnswer, addRemoteIce, sendText, teardown };
window.__ice = [];
window.__msgs = [];
window.__state = 'new';
window.__chanOpen = false;
window.__wrtc = api;
window.__mkHandle = async () => {
  const cert = await api.makeCertificate();
  const h = api.createPeer(cert, {
    onState: (s) => { window.__state = s; },
    onMessage: (t) => { window.__msgs.push(t); },
    onIceCandidate: (c) => { window.__ice.push(c); },
  });
  // observe datachannel open on both sides
  const watch = () => { if (h.channel) { h.channel.onopen = () => { window.__chanOpen = true; };
    if (h.channel.readyState === 'open') window.__chanOpen = true; } };
  const iv = setInterval(watch, 50);
  window.__handle = h; window.__iv = iv; return true;
};
</script>
</body></html>`;
const harnessPath = join(__dir, '_webrtc_harness.html');
writeFileSync(harnessPath, harnessHtml);

// 3) Launch two real Brave instances with fake media.
const launchArgs = [
  '--no-sandbox',
  '--ignore-certificate-errors',
  '--disable-gpu',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];
const mk = () =>
  puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/brave-browser', args: launchArgs });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = await mk();
const B = await mk();
const fails = [];
try {
  const pa = await A.newPage();
  const pb = await B.newPage();
  for (const [name, pg] of [['alice', pa], ['bob', pb]]) {
    pg.on('pageerror', (e) => fails.push(`[${name} pageerror] ${e.message}`));
    pg.on('console', (m) => { if (m.type() === 'error') fails.push(`[${name} console.error] ${m.text()}`.slice(0, 200)); });
  }
  const url = 'file://' + harnessPath;
  await pa.goto(url);
  await pb.goto(url);
  await pa.evaluate('__mkHandle()');
  await pb.evaluate('__mkHandle()');

  // attach fake media on both
  await pa.evaluate('window.__wrtc.attachLocalMedia(window.__handle,{audio:true,video:true}).then(()=>true)');
  await pb.evaluate('window.__wrtc.attachLocalMedia(window.__handle,{audio:true,video:true}).then(()=>true)');
  log('both peers created + fake media attached');

  // alice offer
  const offerSdp = await pa.evaluate('window.__wrtc.makeOffer(window.__handle)');
  log('alice offer SDP bytes:', offerSdp.length, '| has fingerprint:', /a=fingerprint:/.test(offerSdp));
  const offerFp = await pa.evaluate(`window.__wrtc.fingerprintFromSdp(${JSON.stringify(offerSdp)})`);
  log('alice DTLS fingerprint:', offerFp);

  // bob answer (this is what traverses the sealed-offer envelope + RegistryV3)
  const answerSdp = await pb.evaluate(`window.__wrtc.makeAnswer(window.__handle, ${JSON.stringify(offerSdp)})`);
  log('bob answer SDP bytes:', answerSdp.length, '| has fingerprint:', /a=fingerprint:/.test(answerSdp));

  // alice applies answer
  await pa.evaluate(`window.__wrtc.applyAnswer(window.__handle, ${JSON.stringify(answerSdp)})`);
  log('answer applied on alice');

  // trickle ICE both directions (vanilla ICE already in SDP; this adds any late ones)
  const pumpIce = async (fromPg, toPg) => {
    const cands = await fromPg.evaluate('window.__ice.splice(0)');
    for (const c of cands) {
      try { await toPg.evaluate(`window.__wrtc.addRemoteIce(window.__handle, ${JSON.stringify(c)})`); } catch {}
    }
    return cands.length;
  };

  // wait for connection + channel open, pumping ICE
  let connected = false;
  for (let i = 0; i < 40; i++) {
    const na = await pumpIce(pa, pb);
    const nb = await pumpIce(pb, pa);
    const sa = await pa.evaluate('window.__state');
    const sb = await pb.evaluate('window.__state');
    const ca = await pa.evaluate('window.__chanOpen');
    const cb = await pb.evaluate('window.__chanOpen');
    if (i % 5 === 0 || (sa === 'connected' && sb === 'connected'))
      log(`t+${i} alice=${sa} bob=${sb} chanOpen a=${ca} b=${cb} ice(+${na}/${nb})`);
    if ((sa === 'connected' || sa === 'completed') && (ca || cb)) { connected = true; break; }
    await sleep(500);
  }

  // exchange P2P text both ways
  let aliceSent = false, bobSent = false;
  if (connected) {
    aliceSent = await pa.evaluate('window.__wrtc.sendText(window.__handle, "hello-from-alice")');
    bobSent = await pb.evaluate('window.__wrtc.sendText(window.__handle, "hello-from-bob")');
    await sleep(800);
  }
  const bobGot = await pb.evaluate('window.__msgs');
  const aliceGot = await pa.evaluate('window.__msgs');

  const stA = await pa.evaluate('window.__state');
  const stB = await pb.evaluate('window.__state');

  log('\n=== RESULT ===');
  log('alice connState:', stA, '| bob connState:', stB);
  log('alice sent ok:', aliceSent, '| bob sent ok:', bobSent);
  log('bob received:', JSON.stringify(bobGot));
  log('alice received:', JSON.stringify(aliceGot));

  const pass =
    connected &&
    (stA === 'connected' || stA === 'completed') &&
    bobGot.includes('hello-from-alice') &&
    aliceGot.includes('hello-from-bob');
  log('\nTWO-BROWSER WEBRTC:', pass ? 'PASS ✅' : 'FAIL ❌');
  if (fails.length) { log('--- page errors ---'); log(fails.slice(0, 20).join('\n')); }
} finally {
  await A.close();
  await B.close();
}
