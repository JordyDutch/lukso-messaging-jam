// conversations.ts — the persistent DM conversation list (WhatsApp-style).
//
// A "conversation" is just a peer UP you've opened a DM with. We keep the list
// in localStorage (per connected UP) so the chat list survives reloads, seed it
// with the known lab peers, and merge in any peer discovered from already-decoded
// DM threads. The UI reverse-resolves each peer address to its LSP3 @name for
// display (names.ts); the stored record keeps a last-known name + preview so the
// list can render instantly before the indexer answers.

import { WALL_ADDRESS, KNOWN_PEERS } from './config';
import type { WallPost } from './wall';
import { threadIdFor } from './crypto';

export interface Conversation {
  /** peer UP address (checksummed or lowercase; we normalise on read). */
  address: string;
  /** last-known LSP3 name (bare, no #hash) for instant render; refined live. */
  name?: string | null;
  /** last decrypted message preview (public-safe: DM text is only cached in memory, see note). */
  preview?: string;
  /** unix seconds of the most recent message, for sort + list timestamp. */
  ts?: number;
}

const LS_PREFIX = 'updawg.conversations.v1';

function key(me: string): string {
  return `${LS_PREFIX}:${WALL_ADDRESS.toLowerCase()}:${me.toLowerCase()}`;
}

/** Load the persisted conversation list for the connected UP (never throws). */
export function loadConversations(me: string): Conversation[] {
  try {
    const raw = localStorage.getItem(key(me));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is Conversation =>
        !!c && typeof (c as Conversation).address === 'string',
    );
  } catch {
    return [];
  }
}

/** Persist the conversation list for the connected UP (never throws). */
export function saveConversations(me: string, convs: Conversation[]): void {
  try {
    localStorage.setItem(key(me), JSON.stringify(convs));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

/**
 * Merge all conversation sources into one deduped, newest-first list:
 *   - persisted (localStorage) conversations
 *   - the hardcoded KNOWN_PEERS (so you can always DM the lab profiles)
 *   - any peer found in the already-decoded DM threads for this UP
 * A peer's newest message timestamp/preview wins. Keyed by lowercased address.
 */
export function mergeConversations(
  me: string,
  persisted: Conversation[],
  decoded: WallPost[],
): Conversation[] {
  const byAddr = new Map<string, Conversation>();
  const meLc = me.toLowerCase();

  const put = (c: Conversation) => {
    const k = c.address.toLowerCase();
    const prev = byAddr.get(k);
    if (!prev) {
      byAddr.set(k, { ...c });
      return;
    }
    byAddr.set(k, {
      address: prev.address,
      name: c.name ?? prev.name,
      // keep the record carrying the newest timestamp
      ts: Math.max(prev.ts ?? 0, c.ts ?? 0) || undefined,
      preview: (c.ts ?? 0) >= (prev.ts ?? 0) ? c.preview ?? prev.preview : prev.preview,
    });
  };

  // seed known peers first (lowest priority — real data overrides)
  for (const p of KNOWN_PEERS) {
    if (p.address.toLowerCase() === meLc) continue;
    put({ address: p.address, name: p.name });
  }
  // persisted next
  for (const c of persisted) {
    if (c.address.toLowerCase() === meLc) continue;
    put(c);
  }

  // derive the peer + preview from decoded DM threads.
  // Build a reverse map threadId -> {peer, newest post} by matching known peers
  // and persisted addresses (we can only know the peer address if the thread id
  // equals threadIdFor(me, candidate) for some candidate we already know).
  const candidates = new Set<string>([
    ...KNOWN_PEERS.map((p) => p.address),
    ...persisted.map((c) => c.address),
  ]);
  const tidToPeer = new Map<string, string>();
  for (const addr of candidates) {
    if (addr.toLowerCase() === meLc) continue;
    tidToPeer.set(threadIdFor(me, addr).toLowerCase(), addr);
  }

  for (const p of decoded) {
    if (!p.encrypted || p.signal) continue;
    const peer = tidToPeer.get(p.threadId.toLowerCase());
    if (!peer) continue;
    const preview = p.locked
      ? '🔒 encrypted'
      : p.pruned
        ? '🫧 expired'
        : (p.text ?? '').slice(0, 64);
    put({ address: peer, preview, ts: p.timestamp });
  }

  return [...byAddr.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}
