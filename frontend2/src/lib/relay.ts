// relay.ts — LSP25 gas-less blob relay.
//
// Why: a Type-3 (EIP-4844 blob) tx is an OUTER EOA tx, so msg.sender is whoever
// signs it with a secp256k1 key. The UP Browser Extension won't sign Type-3, and
// a UP cannot send Type-3 via LSP0.execute. The fix — proven headless on LUKSO
// mainnet (poc/lab-ups/blob-lsp25-spike.mjs) — is the EXISTING LSP25 relay path:
//
//   relayer EOA  -- Type-3 tx, blob attached -->  UP.KeyManager.executeRelayCall(
//       sig, nonce, validityTimestamps,
//       payload = UP.execute(0, WALL, 0, postBlob(tag, enc, threadId, blobHash, meta)))
//
// `blobhash(0)` is a transaction-level opcode, so it is still read correctly 3
// call frames deep (EOA → KeyManager → UP → Wall). Inside postBlob msg.sender is
// the UP, so PostedBlob.from = the real author, with ZERO WallV2 change. The
// user's controller only ever SIGNS (the LSP25 digest); the relayer pays gas and
// attaches the blob.
//
// This module prepares the signed relay request in the browser and POSTs it to a
// configured relayer (config.BLOB_RELAYER_URL). The relayer is a tiny Type-3-
// capable service the team runs; it does NOT need the user's keys.

import { ethers } from 'ethers';
import { CHAIN_ID, LSP25_VERSION, WALL_ADDRESS, BLOB_RELAYER_URL } from './config';

const UP_ABI = [
  'function owner() view returns (address)',
  'function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)',
];
const KM_ABI = ['function getNonce(address signer, uint128 channel) view returns (uint256)'];
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
 * This is signed as a RAW 32-byte hash (no eth-sign prefix). Matches the mainnet
 * spike byte-for-byte.
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
  keyManager: string;
  signature: string;
  nonce: string; // decimal string (uint256 doesn't JSON-serialize)
  validityTimestamps: string;
  payload: string;
  /** 0x-hex of the 128 KB field-element-encoded blob. */
  blob: string;
}

/**
 * Build + sign an LSP25 relay request for a postBlob call. `blobHex` is the
 * encoded blob (from encodeBlob); `blobHash` is its versioned hash (anchored on
 * chain). The signer is the UP's controller (via the extension). Signs the raw
 * LSP25 digest with eth_sign (no prefix) — the exact form LSP25 verifies.
 */
export async function buildBlobRelayRequest(args: {
  signer: ethers.JsonRpcSigner;
  controllerAddress: string;
  up: string;
  tag: string;
  encrypted: boolean;
  threadId: string;
  blobHash: string;
  meta: Uint8Array;
  blobHex: string;
}): Promise<RelayRequest> {
  const provider = args.signer.provider;
  const keyManager = await keyManagerOf(provider, args.up);

  // inner: UP.execute(CALL=0, WALL, 0, postBlob(...))
  const postBlobData = wallIface.encodeFunctionData('postBlob', [
    args.tag,
    args.encrypted,
    args.threadId,
    args.blobHash,
    ethers.hexlify(args.meta),
  ]);
  const payload = upIface.encodeFunctionData('execute', [0, WALL_ADDRESS, 0, postBlobData]);

  const km = new ethers.Contract(keyManager, KM_ABI, provider);
  const channel = 0n;
  const nonce: bigint = await km.getNonce(args.controllerAddress, channel);
  const validityTimestamps = 0n; // valid indefinitely
  const value = 0n;

  const digest = lsp25Digest(keyManager, nonce, validityTimestamps, value, payload);

  // LSP25 wants the RAW digest signed (EIP-191 v0), i.e. eth_sign over the 32
  // bytes with no personal-message prefix. ethers' signMessage would add the
  // prefix; use the provider's eth_sign directly.
  const signature = (await provider.send('eth_sign', [
    args.controllerAddress,
    digest,
  ])) as string;

  return {
    keyManager,
    signature,
    nonce: nonce.toString(),
    validityTimestamps: validityTimestamps.toString(),
    payload,
    blob: args.blobHex,
  };
}

/** POST a signed relay request to the configured relayer; returns the tx hash. */
export async function sendViaRelayer(req: RelayRequest): Promise<string> {
  if (!BLOB_RELAYER_URL) throw new Error('no blob relayer configured');
  const res = await fetch(BLOB_RELAYER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`relayer ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = (await res.json()) as { txHash?: string; error?: string };
  if (j.error) throw new Error(`relayer: ${j.error}`);
  if (!j.txHash) throw new Error('relayer returned no txHash');
  return j.txHash;
}
