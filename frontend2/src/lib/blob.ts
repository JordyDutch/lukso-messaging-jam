// blob.ts — EIP-4844 blob lane for UP Dawg.
//
// The blob lane carries a post body in an EIP-4844 blob (ephemeral, pruned by
// the beacon chain after ~18 days) and anchors ONLY the KZG versioned hash
// on-chain via WallV2.postBlob. This file is the browser side of the pattern
// proven headless on LUKSO mainnet (poc/lab-ups/blob-spike.mjs, 2026-10-22):
//
//   write : encodeBlob(body) -> ethers builds the Type-3 sidecar + versioned
//           hash from (blobs, kzg); postBlob anchors that hash.
//   read  : PostedBlob.blobHash (on-chain) + tx hash -> map block to beacon
//           slot -> GET /eth/v1/beacon/blob_sidecars/{slot} -> find the sidecar
//           whose 0x01 ++ sha256(kzg_commitment)[1:] == blobHash -> decodeBlob.
//
// The codec here is byte-identical to the headless spike so blobs written by
// either side round-trip.
import { ethers } from 'ethers';
import { loadKZG } from 'kzg-wasm';
import { BEACON_URL } from './config';

// ---- blob field-element codec --------------------------------------------
// A blob is 4096 field elements * 32 bytes = 131072 bytes. Each 32-byte word
// must be < the BLS modulus, so we keep the top byte of every word 0 and pack
// 31 payload bytes per word. Word 0 holds a 4-byte big-endian length (bytes
// 28..31). Max payload = 4095 * 31 = 126945 bytes.
export const FIELD_ELEMENTS = 4096;
export const BLOB_SIZE = FIELD_ELEMENTS * 32; // 131072
export const MAX_BLOB_PAYLOAD = (FIELD_ELEMENTS - 1) * 31; // 126945

export function encodeBlob(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_BLOB_PAYLOAD) {
    throw new Error(`blob payload too large: ${payload.length} > ${MAX_BLOB_PAYLOAD}`);
  }
  const blob = new Uint8Array(BLOB_SIZE); // zero-filled
  const len = payload.length;
  blob[28] = (len >>> 24) & 0xff;
  blob[29] = (len >>> 16) & 0xff;
  blob[30] = (len >>> 8) & 0xff;
  blob[31] = len & 0xff;
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1; // skip the high byte of each word
    for (let i = 0; i < 31 && o < len; i++) blob[base + i] = payload[o++];
  }
  return blob;
}

export function decodeBlob(blob: Uint8Array): Uint8Array {
  const len = (blob[28] << 24) | (blob[29] << 16) | (blob[30] << 8) | blob[31];
  const out = new Uint8Array(len);
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) {
    const base = w * 32 + 1;
    for (let i = 0; i < 31 && o < len; i++) out[o++] = blob[base + i];
  }
  return out;
}

// ---- KZG (lazy, shared) ---------------------------------------------------
// kzg-wasm's loadKZG() returns the trusted-setup-backed KZG functions. ethers
// v6.17 auto-detects this object's API and uses it to build the Type-3 sidecar
// and fill blobVersionedHashes — we never call the KZG functions by hand.
let kzgPromise: Promise<unknown> | null = null;
export function getKZG(): Promise<unknown> {
  if (!kzgPromise) kzgPromise = loadKZG();
  return kzgPromise;
}

const blobHex = (blob: Uint8Array): string => '0x' + bytesToHex(blob);
function bytesToHex(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Compute the EIP-4844 versioned hash for a blob exactly as ethers will put it
 * into the Type-3 sidecar, so the value we anchor in postBlob matches blobhash(0).
 */
export async function versionedHashFor(blob: Uint8Array): Promise<string> {
  const kzg = await getKZG();
  const probe = ethers.Transaction.from({
    type: 3,
    to: ethers.ZeroAddress,
    chainId: 42,
    nonce: 0,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    maxFeePerBlobGas: 1n,
    gasLimit: 21000n,
    data: '0x',
    blobs: [blobHex(blob)],
    kzg: kzg as never,
  });
  return probe.blobVersionedHashes![0];
}

/**
 * Build the Type-3 tx fields that carry `blob`. Merge into an ethers tx request
 * passed to signer.sendTransaction. The caller supplies to/data/fees; this adds
 * the blob sidecar inputs and the type.
 */
export async function blobTxFields(blob: Uint8Array): Promise<{
  type: 3;
  blobs: string[];
  kzg: unknown;
  maxFeePerBlobGas: bigint;
}> {
  const kzg = await getKZG();
  return {
    type: 3,
    blobs: [blobHex(blob)],
    kzg,
    // LUKSO blob base fee sits at the 1-wei floor; 10 gwei cap is ample + cheap.
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'),
  };
}

// ---- Type-3 capability probe ---------------------------------------------
// Can the connected wallet sign/send a Type-3 (blob) transaction? MetaMask —
// and the UP Browser Extension built on it — generally reject type:3 from a
// dapp's eth_sendTransaction. We probe WITHOUT broadcasting: ask the provider
// to eth_signTransaction (or build via the signer) a type:3 tx and see if it
// errors with an unsupported-type / method-not-found shape. Many wallets don't
// expose eth_signTransaction at all; in that case we report 'unknown' and let
// the first real send surface the truth (the UI warns before that).
export type Type3Support = 'yes' | 'no' | 'unknown';

export async function probeType3(
  provider: ethers.Eip1193Provider | null | undefined,
): Promise<Type3Support> {
  if (!provider || typeof provider.request !== 'function') return 'unknown';
  try {
    // eth_signTransaction is the non-broadcasting probe. Most injected wallets
    // reject it outright (method not supported) — that tells us nothing about
    // type 3 specifically, so treat a generic rejection as 'unknown'. Only a
    // type-specific rejection counts as 'no'.
    await provider.request({
      method: 'eth_signTransaction',
      params: [{ type: '0x3', value: '0x0' }],
    });
    return 'yes';
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
    if (
      msg.includes('type 3') ||
      msg.includes('type-3') ||
      msg.includes('blob') ||
      msg.includes('4844') ||
      msg.includes('unsupported transaction type') ||
      msg.includes('invalid transaction type')
    ) {
      return 'no';
    }
    // eth_signTransaction missing / user-rejected / other → inconclusive.
    return 'unknown';
  }
}

// ---- beacon retrieval -----------------------------------------------------
// Recover a blob body by (tx block -> beacon slot -> sidecar), verifying the
// sidecar's commitment hashes to the on-chain anchored versioned hash.

let genesisTimePromise: Promise<number> | null = null;
async function beaconGenesisTime(): Promise<number> {
  if (!genesisTimePromise) {
    genesisTimePromise = fetch(`${BEACON_URL}/eth/v1/beacon/genesis`)
      .then((r) => r.json())
      .then((j) => Number(j.data.genesis_time))
      // Don't cache a rejection — the public LUKSO beacon sends no CORS header
      // to a browser origin (see config BEACON_URL note); if it's swapped for a
      // reachable one at runtime, the next decode should retry, not stay poisoned.
      .catch((e) => {
        genesisTimePromise = null;
        throw e;
      });
  }
  return genesisTimePromise;
}

/** EIP-4844 versioned hash of a KZG commitment: 0x01 ++ sha256(commitment)[1:]. */
async function versionedHashOfCommitment(commitmentHex: string): Promise<string> {
  const commit = ethers.getBytes(commitmentHex);
  const digest = ethers.getBytes(ethers.sha256(commit));
  digest[0] = 0x01;
  return ethers.hexlify(digest);
}

export interface BlobFetch {
  ok: boolean;
  /** decoded payload bytes (present iff ok) */
  payload?: Uint8Array;
  /** 'pruned' = sidecar gone (>~18d); 'mismatch' = no sidecar hashed to blobHash */
  reason?: 'pruned' | 'mismatch' | 'error';
  error?: string;
}

/**
 * Fetch + verify + decode the blob body for a PostedBlob, given its tx hash and
 * the on-chain anchored versioned hash. Uses a read provider only to map the tx
 * block to a timestamp -> slot.
 */
export async function fetchBlobBody(
  readProvider: ethers.Provider,
  txHash: string,
  anchoredHash: string,
): Promise<BlobFetch> {
  try {
    const rcpt = await readProvider.getTransactionReceipt(txHash);
    if (!rcpt) return { ok: false, reason: 'error', error: 'no receipt' };
    const blk = await readProvider.getBlock(rcpt.blockNumber);
    if (!blk) return { ok: false, reason: 'error', error: 'no block' };
    const genesis = await beaconGenesisTime();
    const slot = Math.floor((Number(blk.timestamp) - genesis) / 12);

    const res = await fetch(`${BEACON_URL}/eth/v1/beacon/blob_sidecars/${slot}`);
    if (res.status === 404) return { ok: false, reason: 'pruned' };
    if (!res.ok) return { ok: false, reason: 'error', error: `sidecars ${res.status}` };
    const j = await res.json();
    const sidecars: { kzg_commitment: string; blob: string }[] = j.data ?? [];
    if (sidecars.length === 0) return { ok: false, reason: 'pruned' };

    for (const sc of sidecars) {
      const vh = await versionedHashOfCommitment(sc.kzg_commitment);
      if (vh.toLowerCase() === anchoredHash.toLowerCase()) {
        const blob = ethers.getBytes(sc.blob);
        return { ok: true, payload: decodeBlob(blob) };
      }
    }
    return { ok: false, reason: 'mismatch' };
  } catch (e) {
    return { ok: false, reason: 'error', error: String((e as Error)?.message ?? e) };
  }
}
