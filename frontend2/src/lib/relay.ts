// relay.ts — LSP25 gas-less blob relay, SIGNATURE-first model.
//
// Architecture (proven on LUKSO mainnet, poc/lab-ups/blob-sigrelay-spike.mjs):
// the frontend hands the relayer ONLY a signature + the relay request; it never
// knows (and cannot get) the UP's controller EOA — the UP extension returns the
// UP address and abstracts the controller. The backend recovers the signer from
// the signature, validates it is an authorized LSP6 controller of the UP, meters
// (DAWG/LSP7), and sends the Type-3 blob tx via the UNMODIFIED
// KeyManager.executeRelayCall. blobhash(0) binds 3 frames deep → PostedBlob.from
// is the UP, zero WallV2 change.
//
// Frontend POSTs { up, signature, nonce, validityTimestamps, payload, blob }.
// The nonce comes from the backend (GET /nonce?up=…) because the frontend can't
// name the controller to call getNonce itself.
//
// SIGNATURE FORMAT (the one real in-browser unknown): LSP25 verifies an EIP-191
// v0 signature over the RAW 32-byte digest (no personal-message prefix). We ask
// the extension to produce it. Different extensions expose this differently; we
// try eth_sign first (raw-hash), and the returned signature + any error is
// surfaced to the UI so a human tester can see EXACTLY what the extension did.

import { ethers } from 'ethers';
import { CHAIN_ID, LSP25_VERSION, WALL_ADDRESS, BLOB_RELAYER_URL } from './config';

const UP_ABI = [
  'function owner() view returns (address)',
  'function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)',
];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
];

const upIface = new ethers.Interface(UP_ABI);
const wallIface = new ethers.Interface(WALL_ABI);

/** True when a relayer endpoint is configured; blob posts can be gas-less. */
export function relayerConfigured(): boolean {
  return !!BLOB_RELAYER_URL;
}

/**
 * The LSP25 execute-relay-call digest: EIP-191 version 0, PACKED (leading zeros
 * stripped), keccak256 of:
 *   0x19 00 <keyManager> <LSP25_VERSION u256> <chainId u256> <nonce u256>
 *        <validityTimestamps u256> <value u256> <payload bytes>
 * Signed as a RAW 32-byte hash. Matches the mainnet spike byte-for-byte.
 */
export function lsp25Digest(
  keyManager: string,
  nonce: bigint,
  validityTimestamps: bigint,
  value: bigint,
  payload: string,
): string {
  const packed = ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', keyManager, LSP25_VERSION, CHAIN_ID, nonce, validityTimestamps, value, payload],
  );
  return ethers.keccak256(packed);
}

/** Read the UP's KeyManager (its ERC173 owner). */
export async function keyManagerOf(
  provider: ethers.Provider,
  up: string,
): Promise<string> {
  const c = new ethers.Contract(up, UP_ABI, provider);
  return ethers.getAddress(await c.owner());
}

export interface RelayRequest {
  up: string;
  keyManager: string;
  signature: string;
  nonce: string; // decimal string (uint256 doesn't JSON-serialize)
  validityTimestamps: string;
  payload: string;
  /** 0x-hex of the 128 KB field-element-encoded blob. */
  blob: string;
}

/** Backend /nonce response: the backend picks the UP's controller and returns
 *  its KeyManager + current nonce (the frontend can't name the controller). */
interface NonceResponse {
  keyManager: string;
  nonce: string;
  validityTimestamps?: string;
}

/**
 * Ask the relayer for the nonce to sign for this UP. The relayer reads the UP's
 * AddressPermissions[] and returns the blob-permitted controller's getNonce.
 */
async function fetchRelayNonce(up: string): Promise<NonceResponse> {
  if (!BLOB_RELAYER_URL) throw new Error('no blob relayer configured');
  const base = BLOB_RELAYER_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/nonce?up=${up}`, { method: 'GET' });
  if (!res.ok) throw new Error(`relayer /nonce ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return (await res.json()) as NonceResponse;
}

/** What the signing attempt produced — surfaced to the UI for the human test. */
export interface SignOutcome {
  ok: boolean;
  method: string; // 'eth_sign' | 'personal_sign' | …
  signer: string; // the address the extension signed with (the UP or controller)
  digest: string;
  signature?: string;
  recovered?: string; // ecrecover(digest, sig) — who the sig resolves to
  error?: string;
  keyManager: string;
  nonce: string;
}

/**
 * Build the postBlob relay payload and ask the extension to sign the LSP25
 * digest. Returns BOTH the request (if signing succeeded) and a diagnostic
 * SignOutcome so the UI can show exactly what the extension did — the one thing
 * only a real browser can confirm (caveat 1). `signerAddress` is whatever the
 * extension reports (normally the UP address); we pass it to eth_sign and let
 * the backend recover the true controller.
 */
export async function buildBlobRelayRequest(args: {
  signer: ethers.JsonRpcSigner;
  signerAddress: string;
  up: string;
  tag: string;
  encrypted: boolean;
  threadId: string;
  blobHash: string;
  meta: Uint8Array;
  blobHex: string;
}): Promise<{ req: RelayRequest | null; outcome: SignOutcome }> {
  const provider = args.signer.provider;

  // inner: UP.execute(CALL=0, WALL, 0, postBlob(...))
  const postBlobData = wallIface.encodeFunctionData('postBlob', [
    args.tag,
    args.encrypted,
    args.threadId,
    args.blobHash,
    ethers.hexlify(args.meta),
  ]);
  const payload = upIface.encodeFunctionData('execute', [0, WALL_ADDRESS, 0, postBlobData]);

  // nonce + keyManager from the backend (it names the controller, not us).
  // When NO relayer is configured we still run the signature test standalone:
  // read the KeyManager on-chain and sign over nonce 0. The digest won't be
  // submittable, but the extension's signing behaviour (the real unknown) is
  // what we're probing — see Path 1 in wall.ts.
  let keyManager: string;
  let nonce: bigint;
  let validityTimestamps: bigint;
  if (BLOB_RELAYER_URL) {
    const r = await fetchRelayNonce(args.up);
    keyManager = r.keyManager;
    nonce = BigInt(r.nonce);
    validityTimestamps = BigInt(r.validityTimestamps ?? '0');
  } else {
    keyManager = await keyManagerOf(provider, args.up);
    nonce = 0n;
    validityTimestamps = 0n;
  }
  const value = 0n;
  const digest = lsp25Digest(keyManager, nonce, validityTimestamps, value, payload);

  // Ask the extension to sign the RAW digest (EIP-191 v0). Try eth_sign.
  const outcome: SignOutcome = {
    ok: false, method: 'eth_sign', signer: args.signerAddress, digest, keyManager, nonce: nonce.toString(),
  };
  try {
    const signature = (await provider.send('eth_sign', [args.signerAddress, digest])) as string;
    outcome.signature = signature;
    try { outcome.recovered = ethers.recoverAddress(digest, signature); } catch { /* non-standard sig */ }
    outcome.ok = true;
    const req: RelayRequest = {
      up: args.up,
      keyManager,
      signature,
      nonce: nonce.toString(),
      validityTimestamps: validityTimestamps.toString(),
      payload,
      blob: args.blobHex,
    };
    return { req, outcome };
  } catch (e) {
    outcome.error = (e as { shortMessage?: string; message?: string }).shortMessage
      ?? (e as Error).message ?? String(e);
    return { req: null, outcome };
  }
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
