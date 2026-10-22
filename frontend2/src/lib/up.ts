// up.ts — Universal Profile connection via the injected UP browser extension
// (EIP-1193) + ethers v6.
//
// We open this dApp as a STANDALONE page (served over the VPN at /app/),
// not as a mini-app inside the UP grid. On a standalone page the UP extension
// injects an EIP-1193 provider the same way MetaMask does:
//   - EIP-6963 announceProvider event (preferred, conflict-free discovery), or
//   - window.lukso (the extension's dedicated handle), or
//   - window.ethereum (legacy single-injection fallback).
// We pick the LUKSO provider, wrap it in an ethers BrowserProvider for a signer,
// and use that for EIP-191 signatures + contract writes. No ENS.
//
// (@lukso/up-provider's createClientUPProvider is only used as a last-resort
// fallback: it targets the grid parent window and does nothing on a standalone
// tab, which is why the first cut of this screen appeared to "hang".)
//
// The X25519 *conversation* key is derived deterministically from a fixed
// EIP-191 signature by the UP controller (a constant domain string), so it is
// zero-stored-state and recoverable on any device. The controller private key
// never leaves the extension; we only ever ask it to sign.

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
  /** raw injected EIP-1193 provider (for the Type-3 capability probe). */
  eip1193: ethers.Eip1193Provider;
  convPriv: Uint8Array;
  convPub: Uint8Array;
}

/** EIP-1193 provider surface we rely on. */
type Eip1193 = ethers.Eip1193Provider & {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isUniversalProfileExtension?: boolean;
};

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

/**
 * Discover the LUKSO Universal Profile extension's injected EIP-1193 provider.
 *
 * Order: EIP-6963 announce (wait a tick for extensions to answer) → window.lukso
 * → window.ethereum (only if it looks like the UP extension). Returns null if no
 * UP provider is present so the caller can fall back / show install guidance.
 */
function discoverUpProvider(): Promise<Eip1193 | null> {
  const w = window as unknown as {
    lukso?: Eip1193;
    ethereum?: Eip1193;
    addEventListener: Window['addEventListener'];
    removeEventListener: Window['removeEventListener'];
    dispatchEvent: Window['dispatchEvent'];
  };

  return new Promise((resolve) => {
    const found: Eip6963ProviderDetail[] = [];
    const onAnnounce = (ev: Event) => {
      const detail = (ev as CustomEvent<Eip6963ProviderDetail>).detail;
      if (detail?.provider) found.push(detail);
    };
    w.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    w.dispatchEvent(new Event('eip6963:requestProvider'));

    // Give injected extensions a moment to answer the request event.
    setTimeout(() => {
      w.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      const isUp = (d: Eip6963ProviderDetail) =>
        /universal\s*profile|lukso/i.test(d.info?.name ?? '') ||
        /lukso|universalprofile/i.test(d.info?.rdns ?? '');
      const up6963 = found.find(isUp) ?? null;
      if (up6963) return resolve(up6963.provider);
      if (w.lukso) return resolve(w.lukso);
      if (w.ethereum?.isUniversalProfileExtension) return resolve(w.ethereum);
      // Last resort: a lone injected provider is very likely the UP extension
      // on a LUKSO-only page, but only accept it if nothing else matched.
      if (found.length === 1) return resolve(found[0].provider);
      if (w.ethereum) return resolve(w.ethereum);
      resolve(null);
    }, 350);
  });
}

export async function connectUp(): Promise<UpSession> {
  let up = await discoverUpProvider();

  // Fallback: grid mini-app provider (no-op on a standalone tab, but keeps the
  // app working if it is ever embedded in the UP grid).
  if (!up) {
    try {
      up = createClientUPProvider() as unknown as Eip1193;
    } catch {
      up = null;
    }
  }
  if (!up) {
    throw new Error(
      'No Universal Profile extension found. Install the UP Browser Extension and reload.',
    );
  }

  // Request accounts (opens the extension connection UI).
  const accounts = (await up.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('no UP account returned');

  const provider = new ethers.BrowserProvider(up, CHAIN_ID);
  const signer = await provider.getSigner();
  const address = ethers.getAddress(await signer.getAddress());

  const { convPriv, convPub } = await deriveConvKey(signer);
  return { address, signer, provider, eip1193: up, convPriv, convPub };
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
