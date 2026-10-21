// blobStore.ts — off-chain storage for the sealed SDP/ICE blobs.
//
// The sealed WebRTC offer is far larger than the 200 B on-chain body cap, so
// per the decided design we store it OFF-CHAIN and announce only its hash
// on-chain. This is behind a small interface so the backing store is swappable
// (IPFS now; S3/Arweave/a relay later) without touching signaling or UI code.
//
// Default impl: an IPFS HTTP gateway + a pinning PUT. We DO NOT hardcode a
// pinning secret; the put endpoint is configurable and, if unset, we fall back
// to a content-addressed in-memory store so the encode/decode path still works
// end to end in dev and in tests (documented as a stub in frontend/README.md).

import { ethers } from 'ethers';
import { toBuf } from './crypto';

export interface BlobStore {
  /** store bytes, return a retrieval key (content hash / CID) */
  put(bytes: Uint8Array): Promise<string>;
  /** fetch bytes previously stored under key */
  get(key: string): Promise<Uint8Array>;
  readonly name: string;
}

/**
 * Content-addressed in-memory store. Deterministic keys = keccak256(bytes), so
 * it mirrors the "hash on-chain, blob off-chain" shape exactly. Used in tests
 * and as the dev fallback when no IPFS endpoint is configured. NOT durable and
 * NOT shared across browsers — real calls need a networked store (below).
 */
export class MemoryBlobStore implements BlobStore {
  readonly name = 'memory (stub — not networked)';
  private map = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const key = ethers.keccak256(bytes);
    this.map.set(key, bytes.slice());
    return key;
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.map.get(key);
    if (!v) throw new Error(`blob not found: ${key}`);
    return v;
  }
}

/**
 * IPFS-backed store. `putUrl` is a pinning endpoint that accepts raw bytes and
 * returns `{ cid }` (e.g. a Kubo `/api/v0/add` behind a proxy, or a pinning
 * service). `gatewayUrl` is a read gateway. Both are configurable; no secret is
 * baked in. If putUrl is absent, construction throws so callers fall back to
 * MemoryBlobStore explicitly rather than silently losing data.
 */
export class IpfsBlobStore implements BlobStore {
  readonly name: string;
  constructor(
    private putUrl: string,
    private gatewayUrl: string,
  ) {
    if (!putUrl) throw new Error('IpfsBlobStore requires a put endpoint');
    this.name = `ipfs(${new URL(gatewayUrl).host})`;
  }
  async put(bytes: Uint8Array): Promise<string> {
    const res = await fetch(this.putUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: toBuf(bytes),
    });
    if (!res.ok) throw new Error(`ipfs put failed: ${res.status}`);
    const j = (await res.json()) as { cid?: string; Hash?: string };
    const cid = j.cid ?? j.Hash;
    if (!cid) throw new Error('ipfs put returned no cid');
    return cid;
  }
  async get(cid: string): Promise<Uint8Array> {
    const res = await fetch(`${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${cid}`);
    if (!res.ok) throw new Error(`ipfs get failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Pick a store from env, else the in-memory stub. */
export function makeBlobStore(): BlobStore {
  const putUrl = import.meta.env?.VITE_IPFS_PUT_URL as string | undefined;
  const gateway =
    (import.meta.env?.VITE_IPFS_GATEWAY as string | undefined) ??
    'https://ipfs.io';
  if (putUrl) return new IpfsBlobStore(putUrl, gateway);
  return new MemoryBlobStore();
}
