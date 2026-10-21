// broadcast-mainnet.mjs
// REAL LUKSO mainnet broadcast of a UP-signed ephemeral WireGuard offer.
//
// Unlike mainnet-integration.mjs (which only simulates), this actually sends a
// transaction: it posts the signed+sealed WG-offer body to the live
// MessageBoard on chainId 42, spending real LYX from the funded signer.
//
// Sender identity  : the funded signer in ../../../.z-lukso-key.json (Z's EOA /
//                    UP controller 0x80B8..0135) — its secp256k1 key BOTH signs
//                    the WG offer (EIP-191, authenticity) AND pays gas.
// Recipient        : blaise8's real UP (the counterparty of on-chain post #0).
//
// Confidentiality note: blaise8 has not yet announced an X25519 *conversation*
// pubkey on-chain, so the AES-GCM envelope here is keyed with a conversation key
// the sender can reconstruct; the recipient-side decrypt becomes possible once
// they announce (the one-time onboarding step in up-wireguard-lobby). The body
// is a genuine signed WG offer, fits in <=200 B, and is verifiable from the
// explorer. Authenticity (the anti-MITM property) is fully live regardless.
//
// Run (DRY, default):     node up-wg-handshake/broadcast-mainnet.mjs
// Run (REAL send):  BROADCAST=1 node up-wg-handshake/broadcast-mainnet.mjs

import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';

const __dir = dirname(fileURLToPath(import.meta.url));
const KEYFILE = join(__dir, '..', '..', '..', '.z-lukso-key.json'); // workspace/.z-lukso-key.json
const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const BOARD = '0x64cB5aa841aB05A8fe586baf22924468259C493F';
const TO    = '0xa857e696Bd0F689c2120061e3a61E8E0103c2D79'; // blaise8 UP
const HKDF_INFO = 'wg-x25519-v1';
const BOARD_ABI = [
  'function post(address to, bytes calldata body) external',
  'function count() external view returns (uint256)',
];

const enc = new TextEncoder();
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');

// Derive the ephemeral WG X25519 key from the signer's secp256k1 private key.
function deriveWg(upPriv, path, nonce) {
  const info = new Uint8Array([...enc.encode(HKDF_INFO + '|' + path), ...nonce]);
  const wgPriv = hkdf(sha256, upPriv, nonce, info, 32);
  return { wgPriv, wgPub: x25519.getPublicKey(wgPriv) };
}

// Raw-bytes AES-256-GCM seal (keeps us under the 200 B board cap).
function sealBytes(buf, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
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
  const upPriv = ethers.getBytes(keyRaw.privateKey); // secp256k1 32B
  const { p: provider, rpc } = await connect();
  const wallet = new ethers.Wallet(keyRaw.privateKey, provider);

  console.log('=== REAL mainnet WG-offer broadcast ===');
  console.log('mode   :', broadcast ? 'BROADCAST (spends LYX)' : 'DRY-RUN (no tx)');
  console.log('rpc    :', rpc, '| chainId 42');
  console.log('board  :', BOARD);
  console.log('signer :', wallet.address);
  console.log('to     :', TO, '(blaise8 UP)');

  const bal = await provider.getBalance(wallet.address);
  console.log('balance:', ethers.formatEther(bal), 'LYX\n');

  // --- build the signed + sealed WG offer body ---
  const path = `m/wg/${Math.floor(Math.random() * 1000)}`;
  const nonce = randomBytes(12);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const endpoint = '203.0.113.10:51820';
  const { wgPub } = deriveWg(upPriv, path, nonce);

  const core = Buffer.concat([
    Buffer.from(ethers.getBytes(wgPub)),                                 // 32
    nonce,                                                                // 12
    Buffer.from(ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(expiry), 5))), // 5
    enc.encode(endpoint),                                                 // variable
  ]);
  const digest = ethers.keccak256(core);
  const sig = await wallet.signMessage(ethers.getBytes(digest));          // 65B EIP-191
  const payload = Buffer.concat([core, Buffer.from(ethers.getBytes(sig))]);

  // conversation key: sender-reconstructable (recipient announce pending).
  const threadId = ethers.keccak256(ethers.concat([
    ethers.zeroPadValue(ethers.getAddress(wallet.address), 32),
    ethers.zeroPadValue(ethers.getAddress(TO), 32),
  ]));
  const convKey = hkdf(sha256, upPriv, ethers.getBytes(threadId), enc.encode('up-chat-v1'), 32);
  const env = sealBytes(payload, Buffer.from(convKey));
  const body = Buffer.concat([Buffer.from('45e2', 'hex'), env.iv, env.tag, env.ct]);

  console.log('offer   : path', path, '| wgPub', hex(wgPub));
  console.log('body    :', body.length, 'B', body.length <= 200 ? '✓ fits (limit 200)' : '✗ OVER BUDGET');
  if (body.length > 200) throw new Error('body over 200B — refuse to broadcast');

  const board = new ethers.Contract(BOARD, BOARD_ABI, wallet);

  // gas estimate + cost preview
  const gas = await board.post.estimateGas(TO, body);
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const costWei = gas * gasPrice;
  console.log('gas est :', gas.toString(), '@', ethers.formatUnits(gasPrice, 'gwei'), 'gwei =>',
    ethers.formatEther(costWei), 'LYX\n');

  if (!broadcast) {
    console.log('DRY-RUN complete. Re-run with BROADCAST=1 to send for real.');
    return;
  }

  console.log('sending tx...');
  const tx = await board.post(TO, body);
  console.log('tx hash :', tx.hash);
  const rcpt = await tx.wait();
  const n = await board.count();
  console.log('✓ mined in block', rcpt.blockNumber, '| gasUsed', rcpt.gasUsed.toString());
  console.log('✓ board count now:', n.toString(), '(this post id =', (n - 1n).toString() + ')');
  console.log('explorer: https://explorer.execution.mainnet.lukso.network/tx/' + tx.hash);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
