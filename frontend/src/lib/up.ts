// up.ts — Universal Profile connection via @lukso/up-provider + ethers v6.
//
// The up-provider is an EIP-1193 provider that talks to the UP browser
// extension / the parent grid. We wrap it in an ethers BrowserProvider to get a
// signer for EIP-191 signatures and contract writes. No ENS.
//
// The X25519 *conversation* key is derived deterministically from a fixed
// EIP-191 signature by the UP controller (a constant domain string), so it is
// zero-stored-state and recoverable on any device — the same philosophy as the
// derivation path. The controller private key never leaves the extension; we
// only ever ask it to sign.

import { ethers } from 'ethers';
import { createClientUPProvider } from '@lukso/up-provider';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { CHAIN_ID } from './config';

const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';

export interface UpSession {
  address: string;
  signer: ethers.JsonRpcSigner;
  provider: ethers.BrowserProvider;
  convPriv: Uint8Array;
  convPub: Uint8Array;
}

/** EIP-1193 provider surface we rely on. */
type Eip1193 = ethers.Eip1193Provider & {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export async function connectUp(): Promise<UpSession> {
  const up = createClientUPProvider() as unknown as Eip1193;

  // Request accounts (opens the extension / grid connection UI).
  const accounts = (await up.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('no UP account returned');

  const provider = new ethers.BrowserProvider(up, CHAIN_ID);
  const signer = await provider.getSigner();
  const address = ethers.getAddress(await signer.getAddress());

  const { convPriv, convPub } = await deriveConvKey(signer);
  return { address, signer, provider, convPriv, convPub };
}

/**
 * Deterministic X25519 conv key from a UP signature. We sign a constant string
 * (EIP-191), then HKDF the 65-byte signature into a 32-byte X25519 scalar. Same
 * UP always yields the same conv key; nothing is stored.
 */
export async function deriveConvKey(
  signer: ethers.Signer,
): Promise<{ convPriv: Uint8Array; convPub: Uint8Array }> {
  const sig = await signer.signMessage(CONV_KEY_DOMAIN);
  const ikm = ethers.getBytes(sig);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const convPriv = hkdf(sha256, ikm, salt, new TextEncoder().encode('x25519-conv-v1'), 32);
  return { convPriv, convPub: x25519.getPublicKey(convPriv) };
}

/** bytes32-encode the 32-byte conv pubkey for the registry announce call. */
export function convPubToBytes32(convPub: Uint8Array): string {
  return ethers.hexlify(convPub);
}
