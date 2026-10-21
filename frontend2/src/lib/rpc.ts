// rpc.ts — read-only LUKSO mainnet provider with RPC fallback.
//
// Writes go through the UP provider's signer (up.ts); this read provider is for
// view calls and event log queries so the dApp works even before the user
// connects a wallet.

import { ethers } from 'ethers';
import { RPCS, CHAIN_ID } from './config';

let cached: ethers.JsonRpcProvider | null = null;

export async function getReadProvider(): Promise<ethers.JsonRpcProvider> {
  if (cached) return cached;
  let lastErr: unknown;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
      const net = await p.getNetwork();
      if (Number(net.chainId) === CHAIN_ID) {
        cached = p;
        return p;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no working LUKSO RPC');
}
