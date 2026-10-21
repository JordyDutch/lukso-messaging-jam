// roster.ts — discover UPs that have announced a conversation pubkey.
//
// The RegistryV3 `ConvPubAnnounced(address indexed who, bytes32 convPub)` event
// IS the public directory of "people you can start an encrypted conversation
// with": anyone who has announced a key is reachable. We read that event over a
// moving window (chunked to the 1000-block getLogs cap, same as wall.ts), keep
// the LATEST convPub per address, and hand the list up to the UI, which
// reverse-resolves each address to its @name via names.ts.
//
// Pure read path — no wallet needed, no backend. Works on a static deploy.

import { ethers } from 'ethers';
import { REGISTRY_ADDRESS } from './config';
import { getReadProvider } from './rpc';
import { REGISTRY_ABI } from './registry';

export interface RosterEntry {
  /** UP address that announced a conv pubkey. */
  address: string;
  /** Their latest announced X25519 conversation pubkey (0x…32 bytes). */
  convPub: string;
  /** Block the latest announcement landed in — newest first in the UI. */
  block: number;
}

/**
 * Stream the announced-UP roster. Calls onRoster with the full deduped list
 * (latest convPub per address, newest announcement first) on every poll.
 * Returns a stop() function.
 */
export async function watchRoster(
  onRoster: (entries: RosterEntry[]) => void,
  opts: { pollMs?: number; lookbackBlocks?: number } = {},
): Promise<() => void> {
  const provider = await getReadProvider();
  const reg = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  const pollMs = opts.pollMs ?? 8000;
  const lookback = opts.lookbackBlocks ?? 200_000; // directory wants more history than the feed

  // address (lowercased) -> latest entry
  const byAddr = new Map<string, RosterEntry>();
  let stopped = false;
  const head = await provider.getBlockNumber();
  let from = Math.max(0, head - lookback);

  const ingest = (log: ethers.EventLog) => {
    const who = log.args?.who as string | undefined;
    const convPub = log.args?.convPub as string | undefined;
    if (!who || !convPub) return;
    if (/^0x0*$/.test(convPub)) return; // a zeroing-out / un-announce
    const key = who.toLowerCase();
    const prev = byAddr.get(key);
    if (!prev || log.blockNumber >= prev.block) {
      byAddr.set(key, {
        address: ethers.getAddress(who),
        convPub,
        block: log.blockNumber,
      });
    }
  };

  const emit = () => {
    const all = [...byAddr.values()].sort((a, b) => b.block - a.block);
    onRoster(all);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const to = await provider.getBlockNumber();
      if (to >= from) {
        const STEP = 1000; // LUKSO public RPCs cap eth_getLogs at 1000 blocks.
        for (let lo = from; lo <= to; lo += STEP) {
          const hi = Math.min(lo + STEP - 1, to);
          const logs = (await reg.queryFilter(
            reg.filters.ConvPubAnnounced(),
            lo,
            hi,
          )) as ethers.EventLog[];
          for (const l of logs) ingest(l);
        }
        from = to + 1;
        emit();
      }
    } catch (e) {
      console.warn('[watchRoster] poll failed, retrying:', (e as Error)?.message ?? e);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };

  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
