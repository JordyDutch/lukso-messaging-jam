// registry.ts — on-chain signaling via RegistryV2/V3.
//
// Layers 1-2 calls:
//   announce(convPub)          — publish your X25519 conversation pubkey
//   convPubOf(addr)            — read a peer's announced conv pubkey
//
// WebRTC signaling (needs RegistryV3 — see frontend/contracts/RegistryV3.sol):
//   announceSession(to, threadId, bodyHash, blobRef, kind, expiry)
//   SessionAnnounced event     — peers listen for inbound offers/answers
//   announceIce(threadId, cand)  / IceAnnounced event
//
// Against the lab RegistryV2 (no session fields) the WebRTC calls will revert;
// config.REGISTRY_V3_DEPLOYED gates the UI so we never silently pretend.

import { ethers } from 'ethers';
import { REGISTRY_ADDRESS } from './config';
import { getReadProvider } from './rpc';

/** V2 (deployed, proven on mainnet) + V3 session/ICE extensions (needs deploy). */
export const REGISTRY_ABI = [
  // ---- V2: live on mainnet at REGISTRY_ADDRESS ----
  'function announce(bytes32 convPub) external',
  'function convPubOf(address) view returns (bytes32)',
  'event ConvPubAnnounced(address indexed who, bytes32 convPub)',
  // ---- V3: WebRTC signaling (deploy RegistryV3.sol, then set VITE_REGISTRY_ADDRESS) ----
  'function announceSession(address to, bytes32 threadId, bytes32 bodyHash, string blobRef, uint8 kind, uint40 expiry) external',
  'function announceIce(address to, bytes32 threadId, string candRef) external',
  'event SessionAnnounced(address indexed from, address indexed to, bytes32 indexed threadId, bytes32 bodyHash, string blobRef, uint8 kind, uint40 expiry)',
  'event IceAnnounced(address indexed from, address indexed to, bytes32 indexed threadId, string candRef)',
] as const;

export const SESSION_KIND = { offer: 1, answer: 2 } as const;

export async function readRegistry(): Promise<ethers.Contract> {
  const provider = await getReadProvider();
  return new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
}

export function writeRegistry(signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer);
}

/** 0x000…0 means "not announced". */
export async function convPubOf(addr: string): Promise<string | null> {
  const reg = await readRegistry();
  const v: string = await reg.convPubOf(addr);
  return /^0x0*$/.test(v) ? null : v;
}

export async function announceConvPub(
  signer: ethers.Signer,
  convPub: string,
): Promise<string> {
  const reg = writeRegistry(signer);
  const tx = await reg.announce(convPub);
  await tx.wait();
  return tx.hash;
}
