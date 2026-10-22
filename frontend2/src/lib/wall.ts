// wall.ts — on-chain Wall contract: public posts + encrypted DMs.
//
// Public post : plaintext body, optional @tag (mention), threadId = 0.
// DM post     : ciphertext sealed to the shared X25519 conv key of (me, peer),
//               tag = peer, threadId = keccak(sortedPair(me, peer)).
//
// Reading: we queryFilter the Posted event over a moving window (same reason as
// signaling.ts — public RPCs drop eth_newFilter subscriptions). Public bodies
// decode as UTF-8; encrypted bodies decode only if they belong to a thread we
// can derive the key for (i.e. a DM in which we are a participant AND the other
// side has announced its conv pubkey).

import { ethers } from 'ethers';
import { WALL_ADDRESS } from './config';
import { getReadProvider } from './rpc';
import { encodeBlob, blobTxFields, versionedHashFor, fetchBlobBody } from './blob';
import {
  conversationKey,
  threadIdFor,
  sealBytes,
  openBytes,
  dec,
  enc,
  ub,
} from './crypto';
import { convPubOf } from './registry';

export const WALL_ABI = [
  'function post(address tag, bool encrypted, bytes32 threadId, bytes body) external',
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'function count() view returns (uint256)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
] as const;

export type Lane = 'text' | 'blob';

export interface WallPost {
  id: number;
  from: string;
  tag: string; // 0x000..0 = broadcast
  encrypted: boolean;
  threadId: string;
  timestamp: number;
  lane: Lane;
  txHash: string;
  // TEXT lane: body is in the event. BLOB lane: body rode in the blob (NOT
  // on-chain); bodyRaw is '0x' until the decoder fetches it from the beacon.
  bodyRaw: string; // hex bytes (text: from event; blob: recovered from beacon)
  blobHash?: string; // blob lane: the anchored KZG versioned hash
  metaRaw?: string; // blob lane: tiny framing bytes from the event
  // filled in by the decoder:
  text?: string; // decoded plaintext, or decrypted DM text
  locked?: boolean; // encrypted and we cannot decrypt
  pruned?: boolean; // blob lane: body no longer retrievable (sidecar pruned)
  signal?: boolean; // P2P WebRTC signaling envelope — not a human message
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** ASCII "p2p1:" — the P2P signaling prefix (kept in sync with p2p.ts P2P_MAGIC). */
const P2P_MAGIC_HEX = '70327031';

/** Cheap check (no decrypt): is this encrypted body a P2P signaling envelope? */
function looksLikeP2pSignal(bodyRaw: string): boolean {
  return bodyRaw.replace(/^0x/, '').toLowerCase().startsWith(P2P_MAGIC_HEX);
}

export function readWall(provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(WALL_ADDRESS, WALL_ABI, provider);
}
export function writeWall(signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(WALL_ADDRESS, WALL_ABI, signer);
}

/** Post a PUBLIC plaintext message, optionally tagging a UP. */
export async function postPublic(
  signer: ethers.Signer,
  text: string,
  tag?: string | null,
): Promise<string> {
  const wall = writeWall(signer);
  const body = enc.encode(text);
  const tx = await wall.post(tag ?? ZERO, false, ethers.ZeroHash, body);
  await tx.wait();
  return tx.hash;
}

/**
 * Post an ENCRYPTED DM to `peer`. Requires my conv priv key and the peer's
 * announced conv pub (read from RegistryV3). Seals the plaintext to the shared
 * key; only the two of us can open it.
 */
export async function postDm(args: {
  signer: ethers.Signer;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  /** plaintext to seal, OR … */
  text?: string;
  /** … already-sealed bytes to send verbatim (used by P2P signaling, p2p.ts). */
  rawBody?: Uint8Array;
}): Promise<string> {
  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  let body: Uint8Array;
  if (args.rawBody) {
    body = args.rawBody;
  } else {
    const peerPubHex = await convPubOf(args.peerAddr);
    if (!peerPubHex) throw new Error('peer has not announced a conversation key yet');
    const key = conversationKey(args.myConvPriv, ub(peerPubHex), threadId);
    body = await sealBytes(enc.encode(args.text ?? ''), key);
  }
  const wall = writeWall(args.signer);
  const tx = await wall.post(args.peerAddr, true, threadId, body);
  await tx.wait();
  return tx.hash;
}

// ---- BLOB lane senders ----------------------------------------------------
// Same (tag, encrypted, threadId, body) semantics as the text senders, but the
// body rides in an EIP-4844 blob (ephemeral) and only its KZG versioned hash is
// anchored on-chain via postBlob. Requires a wallet that signs Type-3 txs — if
// the signer/provider refuses type:3, sendTransaction rejects and the caller
// (UI) surfaces it. `meta` carries tiny framing only (never the body).

const IFACE = new ethers.Interface(WALL_ABI);

/** Build + send a Type-3 postBlob tx carrying `body` in a blob. */
async function sendBlobPost(
  signer: ethers.Signer,
  tag: string,
  encrypted: boolean,
  threadId: string,
  body: Uint8Array,
): Promise<string> {
  const blob = encodeBlob(body);
  const blobHash = await versionedHashFor(blob);
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length }));
  const data = IFACE.encodeFunctionData('postBlob', [
    tag,
    encrypted,
    threadId,
    blobHash,
    meta,
  ]);
  const fields = await blobTxFields(blob);
  const tx = await signer.sendTransaction({
    to: WALL_ADDRESS,
    data,
    ...fields,
  });
  await tx.wait();
  return tx.hash;
}

/** Post a PUBLIC plaintext message via the blob lane, optionally tagging a UP. */
export async function postPublicBlob(
  signer: ethers.Signer,
  text: string,
  tag?: string | null,
): Promise<string> {
  return sendBlobPost(signer, tag ?? ZERO, false, ethers.ZeroHash, enc.encode(text));
}

/** Post an ENCRYPTED DM to `peer` via the blob lane. Seals exactly like postDm. */
export async function postDmBlob(args: {
  signer: ethers.Signer;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  text?: string;
  rawBody?: Uint8Array;
}): Promise<string> {
  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  let body: Uint8Array;
  if (args.rawBody) {
    body = args.rawBody;
  } else {
    const peerPubHex = await convPubOf(args.peerAddr);
    if (!peerPubHex) throw new Error('peer has not announced a conversation key yet');
    const key = conversationKey(args.myConvPriv, ub(peerPubHex), threadId);
    body = await sealBytes(enc.encode(args.text ?? ''), key);
  }
  return sendBlobPost(args.signer, args.peerAddr, true, threadId, body);
}

/** Decode a batch of posts for display from my vantage point. */
export async function decodePosts(
  posts: WallPost[],
  me: { addr: string; convPriv: Uint8Array } | null,
): Promise<WallPost[]> {
  // cache peer convPub lookups for this batch
  const pubCache = new Map<string, Uint8Array | null>();
  const getPub = async (addr: string): Promise<Uint8Array | null> => {
    const k = addr.toLowerCase();
    if (pubCache.has(k)) return pubCache.get(k)!;
    let v: Uint8Array | null = null;
    try {
      const hex = await convPubOf(addr);
      v = hex ? ub(hex) : null;
    } catch {
      v = null;
    }
    pubCache.set(k, v);
    return v;
  };

  const readProvider = await getReadProvider();

  const out: WallPost[] = [];
  for (const base of posts) {
    let p = base;
    // BLOB lane: the body is not on-chain. Recover it from the beacon sidecar
    // (verifying the commitment hashes to the anchored blobHash), then decode
    // exactly like a text post. A pruned sidecar (>~18d) leaves the hash but no
    // body — mark it so the UI shows "expired".
    if (p.lane === 'blob') {
      if (!p.blobHash) {
        out.push({ ...p, pruned: true });
        continue;
      }
      const got = await fetchBlobBody(readProvider, p.txHash, p.blobHash);
      if (!got.ok || !got.payload) {
        out.push({ ...p, pruned: got.reason === 'pruned' || got.reason === 'mismatch' });
        continue;
      }
      p = { ...p, bodyRaw: ethers.hexlify(got.payload) };
    }

    if (!p.encrypted) {
      out.push({ ...p, text: safeUtf8(p.bodyRaw) });
      continue;
    }
    // P2P signaling envelope: a bootstrap message for the off-chain channel, not
    // a human chat line. Mark it so the UI can hide it from the DM thread.
    if (looksLikeP2pSignal(p.bodyRaw)) {
      out.push({ ...p, signal: true });
      continue;
    }
    // encrypted: can I open it? Only if I'm a participant and know the peer pub.
    if (me) {
      const meLc = me.addr.toLowerCase();
      const isMine =
        p.from.toLowerCase() === meLc || p.tag.toLowerCase() === meLc;
      if (isMine) {
        const peer = p.from.toLowerCase() === meLc ? p.tag : p.from;
        const peerPub = await getPub(peer);
        if (peerPub) {
          try {
            const threadId = threadIdFor(me.addr, peer);
            const key = conversationKey(me.convPriv, peerPub, threadId);
            const pt = await openBytes(ethers.getBytes(p.bodyRaw), key);
            out.push({ ...p, text: dec.decode(pt) });
            continue;
          } catch {
            /* fall through to locked */
          }
        }
      }
    }
    out.push({ ...p, locked: true });
  }
  return out;
}

function safeUtf8(hex: string): string {
  try {
    return dec.decode(ethers.getBytes(hex));
  } catch {
    return '(unreadable bytes)';
  }
}

/**
 * Load recent posts and subscribe to new ones via a moving-window poller.
 * Calls `onPosts(all)` with the full ordered list each time it grows.
 */
export async function watchWall(
  onPosts: (posts: WallPost[]) => void,
  opts: { pollMs?: number; lookbackBlocks?: number } = {},
): Promise<() => void> {
  const provider = await getReadProvider();
  const wall = readWall(provider);
  const pollMs = opts.pollMs ?? 5000;
  const lookback = opts.lookbackBlocks ?? 90_000; // ~ a few days of history on LUKSO

  const byId = new Map<number, WallPost>();
  let stopped = false;
  const head = await provider.getBlockNumber();
  let from = Math.max(0, head - lookback);

  const ingestText = (log: ethers.EventLog) => {
    const a = log.args;
    if (!a) return;
    const id = Number(a.id);
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      from: ethers.getAddress(a.from),
      tag: ethers.getAddress(a.tag),
      encrypted: Boolean(a.encrypted),
      threadId: a.threadId,
      timestamp: Number(a.timestamp),
      lane: 'text',
      bodyRaw: a.body,
      txHash: log.transactionHash,
    });
  };

  const ingestBlob = (log: ethers.EventLog) => {
    const a = log.args;
    if (!a) return;
    const id = Number(a.id);
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      from: ethers.getAddress(a.from),
      tag: ethers.getAddress(a.tag),
      encrypted: Boolean(a.encrypted),
      threadId: a.threadId,
      timestamp: Number(a.timestamp),
      lane: 'blob',
      bodyRaw: '0x', // recovered from the beacon by decodePosts
      blobHash: a.blobHash,
      metaRaw: a.meta,
      txHash: log.transactionHash,
    });
  };

  const emit = () => {
    const all = [...byId.values()].sort((x, y) => x.id - y.id);
    onPosts(all);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const to = await provider.getBlockNumber();
      if (to >= from) {
        // Chunk to stay within RPC getLogs range limits. LUKSO public RPCs
        // (thirdweb, mainnet.lukso.network) cap eth_getLogs at 1000 blocks per
        // request, so the inclusive window lo..hi must span at most 1000 blocks.
        const STEP = 1000;
        for (let lo = from; lo <= to; lo += STEP) {
          const hi = Math.min(lo + STEP - 1, to);
          const [textLogs, blobLogs] = await Promise.all([
            wall.queryFilter(wall.filters.Posted(), lo, hi) as Promise<ethers.EventLog[]>,
            wall.queryFilter(wall.filters.PostedBlob(), lo, hi) as Promise<ethers.EventLog[]>,
          ]);
          for (const l of textLogs) ingestText(l);
          for (const l of blobLogs) ingestBlob(l);
        }
        from = to + 1;
        emit();
      }
    } catch (e) {
      // transient RPC hiccup — retry next tick, keep window. Surface it so a
      // persistent getLogs failure isn't silently swallowed.
      console.warn('[watchWall] poll failed, retrying:', (e as Error)?.message ?? e);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };

  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
