// deploy-lobby.mjs
// Deploy the LSP8-shaped LobbyRegistry to LUKSO mainnet (chainId 42) and mint a
// real lobby invite to blaise8's UP carrying the sealed WireGuard offer.
//
// This is the LSP8 half of the up-wireguard-lobby design: sending the token IS
// the follow/lobby-entry signal; the recipient UP's Universal Receiver fires
// (the "popup"); the token data is the same <=200 B signed+sealed WG offer as
// broadcast-mainnet.mjs. Idempotent via lobby-state.json (won't redeploy).
//
// Run (DRY, default):     node up-wg-handshake/deploy-lobby.mjs
// Run (REAL send):  BROADCAST=1 node up-wg-handshake/deploy-lobby.mjs

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const solc = require('../node_modules/solc');

const __dir = dirname(fileURLToPath(import.meta.url));
const KEYFILE = join(__dir, '..', '..', '..', '.z-lukso-key.json');
const STATEFILE = join(__dir, 'lobby-state.json');
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const TO = '0xa857e696Bd0F689c2120061e3a61E8E0103c2D79'; // blaise8 UP
const HKDF_INFO = 'wg-x25519-v1';
const enc = new TextEncoder();
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');

function loadState() { try { return JSON.parse(readFileSync(STATEFILE, 'utf8')); } catch { return {}; } }
function saveState(s) { writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }

function compile() {
  const src = readFileSync(join(__dir, 'LobbyRegistry.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'LobbyRegistry.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['LobbyRegistry.sol']['LobbyRegistry'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

function deriveWg(upPriv, path, nonce) {
  const info = new Uint8Array([...enc.encode(HKDF_INFO + '|' + path), ...nonce]);
  const wgPriv = hkdf(sha256, upPriv, nonce, info, 32);
  return { wgPriv, wgPub: x25519.getPublicKey(wgPriv) };
}
function sealBytes(buf, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

// Build the same <=200 B signed+sealed WG-offer body used on the board.
async function buildOfferBody(wallet, upPriv, toAddr) {
  const path = `m/wg/${Math.floor(Math.random() * 1000)}`;
  const nonce = randomBytes(12);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const endpoint = '203.0.113.10:51820';
  const { wgPub } = deriveWg(upPriv, path, nonce);
  const core = Buffer.concat([
    Buffer.from(ethers.getBytes(wgPub)), nonce,
    Buffer.from(ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(expiry), 5))),
    enc.encode(endpoint),
  ]);
  const sig = await wallet.signMessage(ethers.getBytes(ethers.keccak256(core)));
  const payload = Buffer.concat([core, Buffer.from(ethers.getBytes(sig))]);
  const threadId = ethers.keccak256(ethers.concat([
    ethers.zeroPadValue(ethers.getAddress(wallet.address), 32),
    ethers.zeroPadValue(ethers.getAddress(toAddr), 32),
  ]));
  const convKey = hkdf(sha256, upPriv, ethers.getBytes(threadId), enc.encode('up-chat-v1'), 32);
  const env = sealBytes(payload, Buffer.from(convKey));
  return Buffer.concat([Buffer.from('45e2', 'hex'), env.iv, env.tag, env.ct]);
}

async function connect() {
  let lastErr;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      const net = await p.getNetwork();
      if (net.chainId !== 42n) throw new Error(`wrong chainId ${net.chainId}`);
      return { p, rpc };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

async function main() {
  const broadcast = process.env.BROADCAST === '1';
  const keyRaw = JSON.parse(readFileSync(KEYFILE, 'utf8'));
  const upPriv = ethers.getBytes(keyRaw.privateKey);
  const { p: provider, rpc } = await connect();
  const wallet = new ethers.Wallet(keyRaw.privateKey, provider);
  const state = loadState();

  console.log('=== LobbyRegistry (LSP8-shaped) deploy + invite ===');
  console.log('mode   :', broadcast ? 'BROADCAST (spends LYX)' : 'DRY-RUN (no tx)');
  console.log('rpc    :', rpc, '| chainId 42');
  console.log('lobby  :', wallet.address, '(owner / issuer)');
  console.log('guest  :', TO, '(blaise8 UP)');
  console.log('balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'LYX\n');

  const { abi, bytecode } = compile();
  console.log('compiled LobbyRegistry: bytecode', (bytecode.length - 2) / 2, 'B, abi', abi.length, 'entries');

  const body = await buildOfferBody(wallet, upPriv, TO);
  const tokenId = ethers.keccak256(ethers.toUtf8Bytes('lobby:' + wallet.address.toLowerCase() + ':blaise8'));
  console.log('invite body:', body.length, 'B', body.length <= 200 ? '✓' : '✗ OVER');
  console.log('tokenId    :', tokenId);

  if (!broadcast) {
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const deployTx = await factory.getDeployTransaction();
    const gas = await provider.estimateGas({ ...deployTx, from: wallet.address });
    const fee = await provider.getFeeData();
    const gp = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    console.log('\nDRY-RUN: deploy gas est', gas.toString(), '@', ethers.formatUnits(gp, 'gwei'),
      'gwei =>', ethers.formatEther(gas * gp), 'LYX (+ one invite tx)');
    console.log('Re-run with BROADCAST=1 to deploy + mint for real.');
    return;
  }

  // 1. deploy (idempotent)
  let registry;
  if (state.registryAddress) {
    console.log('\nregistry already deployed at', state.registryAddress, '- reusing');
    registry = new ethers.Contract(state.registryAddress, abi, wallet);
  } else {
    console.log('\ndeploying LobbyRegistry...');
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    registry = await factory.deploy();
    const dtx = registry.deploymentTransaction();
    console.log('deploy tx:', dtx.hash);
    await registry.waitForDeployment();
    state.registryAddress = await registry.getAddress();
    state.deployTx = dtx.hash;
    saveState(state);
    console.log('✓ deployed at', state.registryAddress);
  }

  // 2. mint the lobby invite to blaise8 (idempotent)
  if (state.inviteTx) {
    console.log('invite already minted:', state.inviteTx, '- skipping');
  } else {
    console.log('minting lobby invite to blaise8...');
    const tx = await registry.invite(TO, tokenId, body);
    console.log('invite tx:', tx.hash);
    const rcpt = await tx.wait();
    state.inviteTx = tx.hash;
    state.tokenId = tokenId;
    saveState(state);
    console.log('✓ minted in block', rcpt.blockNumber, '| gasUsed', rcpt.gasUsed.toString());
    // did the receiver notification happen?
    const ev = rcpt.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((e) => e.name === 'ReceiverNotified');
    if (ev) console.log('  URD notified:', ev.args.to, '=>', ev.args.ok ? 'ok' : 'no-op (EOA or URD declined)');
  }

  const owner = await registry.tokenOwnerOf(tokenId);
  console.log('\non-chain check: tokenOwnerOf(tokenId) =', owner, owner.toLowerCase() === TO.toLowerCase() ? '✓ blaise8 holds it' : '');
  console.log('explorer: https://explorer.execution.mainnet.lukso.network/address/' + state.registryAddress);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
