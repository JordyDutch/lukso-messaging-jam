// relay.ts — gas-less blob relay, AUTHOR-SIGNATURE model (Option B).
//
// Why not LSP25 executeRelayCall anymore: the LSP25 KeyManager verifies a RAW
// 32-byte EIP-191 v0 digest (no personal-message prefix). Browser UP extensions
// only expose personal_sign-style signing, which applies the
// "\x19Ethereum Signed Message:\n32" prefix — the KeyManager rejects it. So a
// relayed LSP25 post is impossible from the browser today.
//
// Author-signature model instead: the user signs a canonical message that binds
// (up, wall, chainId, tag, encrypted, threadId, blobHash, len, nonce) with
// personal_sign — the one thing every extension can do. The relayer:
//   1. recovers the signer from that EIP-191 personal signature,
//   2. checks the signer is an authorized LSP6 controller of the claimed UP,
//   3. posts the blob AS ITSELF (on-chain from = relayer), embedding the
//      author proof (up + nonce + signature + name) in WallV2 `meta`.
// Readers recover the signer from `meta`, re-check it controls `meta.up`, and
// treat that UP as the authoritative author. No WallV2 change; no raw-digest.
//
// Frontend POSTs { up, upName, tag, encrypted, threadId, blobHash, len, nonce,
//                  chainId, wall, signature, blob }.

import { ethers } from 'ethers';
import { CHAIN_ID, WALL_ADDRESS, BLOB_RELAYER_URL } from './config';

const UP_ABI = [
  'function owner() view returns (address)',
];

/** True when a relayer endpoint is configured; blob posts can be gas-less. */
export function relayerConfigured(): boolean {
  return !!BLOB_RELAYER_URL;
}

/** Read the UP's KeyManager (its ERC173 owner). Kept for diagnostics. */
export async function keyManagerOf(
  provider: ethers.Provider,
  up: string,
): Promise<string> {
  const c = new ethers.Contract(up, UP_ABI, provider);
  return ethers.getAddress(await c.owner());
}

export interface AuthMessageFields {
  chainId: number | bigint;
  wall: string;
  up: string;
  tag: string;
  encrypted: boolean;
  threadId: string;
  blobHash: string;
  len: number;
  nonce: string; // decimal string, client-chosen anti-replay
}

/**
 * Canonical author message — EIP-191 personal_sign over this exact UTF-8 string.
 * MUST match poc/lab-ups/blob-relayer-server.mjs buildAuthMessage byte-for-byte.
 */
export function buildAuthMessage(m: AuthMessageFields): string {
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

export interface RelayRequest {
  up: string;
  upName: string;
  tag: string;
  encrypted: boolean;
  threadId: string;
  blobHash: string;
  len: number;
  nonce: string;
  chainId: number;
  wall: string;
  signature: string;
  /** 0x-hex of the 128 KB field-element-encoded blob. */
  blob: string;
}

/** What the signing attempt produced — surfaced to the UI for the human test. */
export interface SignOutcome {
  ok: boolean;
  method: string;
  signer: string;    // address the extension reports it signed with
  recovered?: string; // ecrecover over the EIP-191 personal digest
  message: string;   // the canonical message that was signed
  signature?: string;
  error?: string;
}

/**
 * Build the canonical author message and personal_sign it. Returns the relay
 * request (when signing succeeded) plus a diagnostic SignOutcome. UP-agnostic:
 * nothing is hardcoded — the relayer recovers the signer and validates it
 * controls `up`.
 */
export async function buildBlobRelayRequest(args: {
  signer: ethers.JsonRpcSigner;
  signerAddress: string;
  up: string;
  upName: string;
  tag: string;
  encrypted: boolean;
  threadId: string;
  blobHash: string;
  len: number;
  blobHex: string;
}): Promise<{ req: RelayRequest | null; outcome: SignOutcome }> {
  // Client-chosen nonce: ms timestamp is fine (anti-replay only; the signature
  // already binds the exact blobHash, so a replay would re-post identical bytes).
  const nonce = Date.now().toString();
  const message = buildAuthMessage({
    chainId: CHAIN_ID,
    wall: WALL_ADDRESS,
    up: args.up,
    tag: args.tag,
    encrypted: args.encrypted,
    threadId: args.threadId,
    blobHash: args.blobHash,
    len: args.len,
    nonce,
  });

  const outcome: SignOutcome = {
    ok: false, method: 'personal_sign', signer: args.signerAddress, message,
  };

  // signMessage uses the extension's personal_sign under the hood → EIP-191
  // prefixed, which is exactly what the relayer verifies with verifyMessage.
  let signature: string;
  try {
    signature = await args.signer.signMessage(message);
  } catch (e: unknown) {
    outcome.error = `extension could not sign: ${(e as Error)?.message ?? String(e)}`;
    return { req: null, outcome };
  }

  let recovered: string | undefined;
  try { recovered = ethers.verifyMessage(message, signature); } catch { /* */ }
  outcome.ok = true;
  outcome.signature = signature;
  outcome.recovered = recovered;

  const req: RelayRequest = {
    up: args.up,
    upName: args.upName ?? '',
    tag: args.tag,
    encrypted: args.encrypted,
    threadId: args.threadId,
    blobHash: args.blobHash,
    len: args.len,
    nonce,
    chainId: Number(CHAIN_ID),
    wall: WALL_ADDRESS,
    signature,
    blob: args.blobHex,
  };
  return { req, outcome };
}

/**
 * Read a UP's authorized LSP6 controllers (AddressPermissions[] via ERC725Y),
 * keeping only addresses with a non-zero permission value. Used for read-side
 * author verification (recover signer → confirm it controls the claimed UP).
 */
const AP_ARRAY_KEY = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const PERM_PREFIX = '0x4b80742de2bf82acb3630000';
const ERC725Y_ABI = ['function getData(bytes32 dataKey) view returns (bytes)'];

export async function upControllers(provider: ethers.Provider, up: string): Promise<string[]> {
  const c = new ethers.Contract(up, ERC725Y_ABI, provider);
  const lenHex: string = await c.getData(AP_ARRAY_KEY);
  const n = lenHex && lenHex !== '0x' ? Number(BigInt(lenHex)) : 0;
  const head = AP_ARRAY_KEY.slice(2, 2 + 32);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idxKey = '0x' + head + BigInt(i).toString(16).padStart(32, '0');
    const elem: string = await c.getData(idxKey);
    if (!elem || elem.length < 42) continue;
    const addr = ethers.getAddress('0x' + elem.slice(-40));
    const perm: string = await c.getData(PERM_PREFIX + addr.slice(2).toLowerCase());
    if (perm && perm !== '0x' && BigInt(perm) !== 0n) out.push(addr);
  }
  return out;
}

/** True if `addr` is an authorized LSP6 controller of `up` (non-zero perms). */
export async function isControllerOf(provider: ethers.Provider, up: string, addr: string): Promise<boolean> {
  const c = new ethers.Contract(up, ERC725Y_ABI, provider);
  const perm: string = await c.getData(PERM_PREFIX + addr.slice(2).toLowerCase());
  return !!perm && perm !== '0x' && BigInt(perm) !== 0n;
}

/** POST a signed relay request to the configured relayer; returns the tx hash. */
export async function sendViaRelayer(req: RelayRequest): Promise<string> {
  if (!BLOB_RELAYER_URL) throw new Error('no blob relayer configured');
  const base = BLOB_RELAYER_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`relayer /execute ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = (await res.json()) as { txHash?: string; error?: string };
  if (j.error) throw new Error(`relayer: ${j.error}`);
  if (!j.txHash) throw new Error('relayer returned no txHash');
  return j.txHash;
}
