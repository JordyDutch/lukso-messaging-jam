// e2e-loop.mjs — full UP-identity → WireGuard, fully E2E, on LUKSO mainnet (42).
//
// Isolated lab. Two FRESH controllers (Alice, Bob) that we fully control, each
// with a secp256k1 identity + an X25519 conversation keypair. Flow:
//   1. ensure both controllers funded (top up 0.1 LYX each from the funder)
//   2. deploy LobbyRegistryV2 once (announce + invite), idempotent
//   3. Alice & Bob announce() their conv-pubkeys ON-CHAIN
//   4. Alice invite()s Bob with the sealed WG offer body (the lobby signal)
//   5. Bob reads the invite body + Alice's announced conv-pubkey FROM CHAIN,
//      derives the shared key, DECRYPTS the endpoint, verifies the signature
//   6. Bob replies with his own offer; Alice does the same
//   7. both derive their ephemeral WG keys -> raise a REAL wg tunnel + ping
//
// Keys persisted in ./keys (gitignored). State in ./e2e-state.json (public).
// Run:  BROADCAST=1 node up-wg-handshake/e2e-lab/e2e-loop.mjs
//       (dry run without BROADCAST just does the off-chain crypto + size check)

import { secp256k1, x25519, ethers, deriveWg, buildOffer, openOffer, hx, ub } from './lab-crypto.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('../../node_modules/solc');

const __dir = dirname(fileURLToPath(import.meta.url));
const KEYDIR = join(__dir, 'keys');
const STATEFILE = join(__dir, 'e2e-state.json');
const FUNDERKEY = join(__dir, '..', '..', '..', '..', '.z-lukso-key.json'); // workspace/.z-lukso-key.json
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const TOPUP = ethers.parseEther('0.1');
const MIN_BAL = ethers.parseEther('0.02'); // top up if below this
const BROADCAST = process.env.BROADCAST === '1';

if (!existsSync(KEYDIR)) mkdirSync(KEYDIR, { recursive: true });
const loadState = () => { try { return JSON.parse(readFileSync(STATEFILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => writeFileSync(STATEFILE, JSON.stringify(s, null, 2));
const log = (...a) => console.log(...a);

function loadOrMakeIdentity(name) {
  const f = join(KEYDIR, name + '.json');
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { ...j, ctrl: ub(j.ctrlPriv), conv: ub(j.convPriv) };
  }
  const ctrl = secp256k1.utils.randomPrivateKey();
  const conv = x25519.utils.randomPrivateKey();
  const wallet = new ethers.Wallet(hx(ctrl));
  const j = {
    name, address: wallet.address, ctrlPriv: hx(ctrl), convPriv: hx(conv),
    convPub: hx(x25519.getPublicKey(conv)),
  };
  writeFileSync(f, JSON.stringify(j, null, 2));
  return { ...j, ctrl, conv };
}

async function connect() {
  let e;
  for (const rpc of RPCS) {
    try { const p = new ethers.JsonRpcProvider(rpc); if ((await p.getNetwork()).chainId === 42n) return { p, rpc }; }
    catch (err) { e = err; }
  }
  throw e || new Error('no RPC');
}

function compile() {
  const src = readFileSync(join(__dir, 'LobbyRegistryV2.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'R.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((x) => x.severity === 'error');
  if (errs.length) { errs.forEach((x) => console.error(x.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['R.sol']['LobbyRegistryV2'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function ensureFunded(provider, funder, addr, label) {
  const bal = await provider.getBalance(addr);
  log(`  ${label} ${addr} bal ${ethers.formatEther(bal)} LYX`);
  if (bal >= MIN_BAL) return;
  if (!BROADCAST) { log(`  (would top up ${label} with 0.1 LYX)`); return; }
  log(`  topping up ${label} with 0.1 LYX...`);
  const tx = await funder.sendTransaction({ to: addr, value: TOPUP });
  await tx.wait();
  log(`  ✓ topped up ${label}: ${tx.hash}`);
}

const REG_ABI = [
  'function announce(bytes32 convPub) external',
  'function convPubOf(address) view returns (bytes32)',
  'function invite(address to, bytes32 tokenId, bytes body) external',
  'function tokenOwnerOf(bytes32) view returns (address)',
  'function tokenDataOf(bytes32) view returns (bytes)',
  'event LobbyInvite(bytes32 indexed tokenId, address indexed lobby, address indexed to, bytes body)',
];

async function main() {
  const state = loadState();
  const { p: provider, rpc } = await connect();
  const funderRaw = JSON.parse(readFileSync(FUNDERKEY, 'utf8'));
  const funder = new ethers.Wallet(funderRaw.privateKey, provider);

  const alice = loadOrMakeIdentity('alice');
  const bob = loadOrMakeIdentity('bob');
  const aw = new ethers.Wallet(hx(alice.ctrl), provider);
  const bw = new ethers.Wallet(hx(bob.ctrl), provider);

  log('=== UP → WireGuard fully-E2E loop (mainnet 42) ===');
  log('mode   :', BROADCAST ? 'BROADCAST' : 'DRY-RUN');
  log('rpc    :', rpc);
  log('funder :', funder.address, ethers.formatEther(await provider.getBalance(funder.address)), 'LYX');
  log('alice  :', alice.address, '| bob:', bob.address);

  // 1. fund controllers
  log('\n[1] fund controllers');
  await ensureFunded(provider, funder, alice.address, 'alice');
  await ensureFunded(provider, funder, bob.address, 'bob');

  if (!BROADCAST) {
    // off-chain crypto smoke test (no chain)
    log('\n[dry] off-chain crypto check (recipient really decrypts)');
    const off = await buildOffer({ fromCtrlWallet: aw, fromCtrlPriv: alice.ctrl, fromConvPriv: alice.conv,
      toConvPub: ub(bob.convPub), toAddr: bob.address, endpoint: '203.0.113.10:51820' });
    const v = openOffer({ body: off.body, myConvPriv: bob.conv, fromConvPub: ub(alice.convPub),
      fromAddr: alice.address, toAddr: bob.address, expectFrom: alice.address });
    log('  body', off.body.length, 'B | bob decrypted endpoint:', v.endpoint, '| sig ok:', v.verifiedFrom === alice.address);
    log('\nDRY-RUN ok. Re-run with BROADCAST=1 to execute on mainnet.');
    return;
  }

  // 2. deploy registry (idempotent)
  log('\n[2] registry');
  const { abi, bytecode } = compile();
  let reg;
  if (state.registry) { log('  reuse', state.registry); reg = new ethers.Contract(state.registry, REG_ABI, provider); }
  else {
    const f = new ethers.ContractFactory(abi, bytecode, funder);
    const c = await f.deploy(); log('  deploy tx', c.deploymentTransaction().hash);
    await c.waitForDeployment(); state.registry = await c.getAddress(); saveState(state);
    log('  ✓ deployed', state.registry); reg = new ethers.Contract(state.registry, REG_ABI, provider);
  }

  // 3. both announce conv-pubkeys on-chain
  log('\n[3] announce conv-pubkeys on-chain');
  for (const [w, id] of [[aw, alice], [bw, bob]]) {
    const onchain = await reg.convPubOf(id.address);
    if (onchain.toLowerCase() === id.convPub.toLowerCase()) { log(`  ${id.name} already announced`); continue; }
    const tx = await reg.connect(w).announce(id.convPub); await tx.wait();
    log(`  ✓ ${id.name} announced ${id.convPub} (${tx.hash})`);
  }

  // 4. Alice builds + posts the sealed offer as a lobby invite
  log('\n[4] Alice invites Bob with sealed WG offer');
  const aliceConvPubOnchain = await reg.convPubOf(alice.address);
  const bobConvPubOnchain = await reg.convPubOf(bob.address);
  const offerAB = await buildOffer({ fromCtrlWallet: aw, fromCtrlPriv: alice.ctrl, fromConvPriv: alice.conv,
    toConvPub: ub(bobConvPubOnchain), toAddr: bob.address, endpoint: '203.0.113.10:51820' });
  const tokenAB = ethers.keccak256(ethers.toUtf8Bytes('lobby:alice->bob:' + Date.now()));
  if (offerAB.body.length > 200) throw new Error('offer over 200B');
  { const tx = await reg.connect(aw).invite(bob.address, tokenAB, offerAB.body); await tx.wait();
    log('  ✓ invite tx', tx.hash, '| body', offerAB.body.length, 'B | token', tokenAB.slice(0, 18) + '…'); }

  // 5. Bob reads EVERYTHING from chain and decrypts
  log('\n[5] Bob reads invite + Alice conv-pubkey FROM CHAIN, decrypts');
  const bodyOnchain = ub(await reg.tokenDataOf(tokenAB));
  const aliceConvFromChain = await reg.convPubOf(alice.address);
  const bobView = openOffer({ body: Buffer.from(bodyOnchain), myConvPriv: bob.conv,
    fromConvPub: ub(aliceConvFromChain), fromAddr: alice.address, toAddr: bob.address, expectFrom: alice.address });
  log('  ✓ Bob decrypted endpoint:', bobView.endpoint);
  log('  ✓ verified signer == Alice:', bobView.verifiedFrom === alice.address);
  log('  ✓ Alice WG pubkey:', bobView.peerWgPub);

  // 6. Bob replies on-chain with his offer; Alice reads+decrypts
  log('\n[6] Bob replies, Alice reads+decrypts');
  const offerBA = await buildOffer({ fromCtrlWallet: bw, fromCtrlPriv: bob.ctrl, fromConvPriv: bob.conv,
    toConvPub: ub(aliceConvFromChain), toAddr: alice.address, endpoint: '198.51.100.20:51820' });
  const tokenBA = ethers.keccak256(ethers.toUtf8Bytes('lobby:bob->alice:' + Date.now()));
  { const tx = await reg.connect(bw).invite(alice.address, tokenBA, offerBA.body); await tx.wait();
    log('  ✓ reply tx', tx.hash); }
  const aliceView = openOffer({ body: Buffer.from(ub(await reg.tokenDataOf(tokenBA))), myConvPriv: alice.conv,
    fromConvPub: ub(bobConvPubOnchain), fromAddr: bob.address, toAddr: alice.address, expectFrom: bob.address });
  log('  ✓ Alice decrypted endpoint:', aliceView.endpoint, '| Bob WG pubkey:', aliceView.peerWgPub);

  // 7. derive ephemeral WG keys on BOTH sides and raise a REAL tunnel
  log('\n[7] raise REAL WireGuard tunnel from on-chain-sourced offers');
  // Alice re-derives her own wg priv from (path,nonce) carried in her own offer;
  // Bob re-derives his. Each side's wgPriv + peer's wgPub (from chain) => tunnel.
  const aliceWg = deriveWg(alice.ctrl, offerAB.path, offerAB.nonce);
  const bobWg = deriveWg(bob.ctrl, offerBA.path, offerBA.nonce);
  // sanity: the pubkey Bob decrypted from chain must equal Alice's derived pub
  if (bobView.peerWgPub.toLowerCase() !== hx(aliceWg.wgPub).toLowerCase()) throw new Error('alice wgpub mismatch chain vs derived');
  if (aliceView.peerWgPub.toLowerCase() !== hx(bobWg.wgPub).toLowerCase()) throw new Error('bob wgpub mismatch chain vs derived');
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const args = [b64(aliceWg.wgPriv), b64(aliceWg.wgPub), b64(bobWg.wgPriv), b64(bobWg.wgPub)];
  log('  derived both ephemeral WG keypairs; raising tunnel in isolated netns...');
  const out = execFileSync('bash', [join(__dir, 'wg-tunnel-test.sh'), ...args], { encoding: 'utf8' });
  log(out.split('\n').map((l) => '    ' + l).join('\n'));

  state.lastRun = { at: new Date().toISOString(), tokenAB, tokenBA, aliceEndpointSeenByBob: bobView.endpoint, bobEndpointSeenByAlice: aliceView.endpoint };
  saveState(state);
  log('\n=== FULLY E2E: identity(UP) → announce → sealed offer on-chain → recipient decrypt → real WG tunnel + ping ===');
  log('registry:', state.registry);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
