// crypto.test.ts — smoke tests for the CI-exercisable paths: layers 1-3 crypto
// and the sealed-offer encode/decode. A real two-browser WebRTC call cannot run
// in CI (documented stub in Call.tsx / README); these tests prove the parts
// that CAN run: ECDH symmetry, seal/open roundtrip, signature verify, expiry,
// domain separation, and the hash+blob signaling envelope.

import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { ethers } from 'ethers';

import {
  conversationKey,
  threadIdFor,
  sealBytes,
  openBytes,
  deriveWg,
  deriveDtlsSeed,
  hx,
  ub,
  HKDF_INFO_WG,
  HKDF_INFO_WEBRTC,
} from '../src/lib/crypto';
import { buildSealedOffer, openSealedOffer } from '../src/lib/offer';
import { MemoryBlobStore } from '../src/lib/blobStore';

function mkIdentity() {
  const ctrl = secp256k1.utils.randomPrivateKey();
  const conv = x25519.utils.randomPrivateKey();
  const wallet = new ethers.Wallet(hx(ctrl));
  return { ctrl, conv, convPub: x25519.getPublicKey(conv), wallet, address: wallet.address };
}

describe('layer 3: static-static X25519 ECDH conversation key', () => {
  it('both parties derive the identical key (order-independent)', () => {
    const a = mkIdentity();
    const b = mkIdentity();
    const tid = threadIdFor(a.address, b.address);
    const ka = conversationKey(a.conv, b.convPub, tid);
    const kb = conversationKey(b.conv, a.convPub, tid);
    expect(hx(ka)).toEqual(hx(kb));
  });

  it('threadId is symmetric', () => {
    const a = mkIdentity();
    const b = mkIdentity();
    expect(threadIdFor(a.address, b.address)).toEqual(threadIdFor(b.address, a.address));
  });
});

describe('seal/open AES-256-GCM (WebCrypto)', () => {
  it('roundtrips and rejects tamper', async () => {
    const key = new Uint8Array(32).fill(7);
    const msg = new TextEncoder().encode('hello webrtc world');
    const sealed = await sealBytes(msg, key);
    const opened = await openBytes(sealed, key);
    expect(new TextDecoder().decode(opened)).toEqual('hello webrtc world');

    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await expect(openBytes(tampered, key)).rejects.toBeTruthy();
  });
});

describe('derivation path domain separation', () => {
  it('WG and WebRTC tags differ, keys never collide from the same seed', () => {
    expect(HKDF_INFO_WG).toEqual('wg-x25519-v1');
    expect(HKDF_INFO_WEBRTC).toEqual('webrtc-dtls-v1');
    const ctrl = secp256k1.utils.randomPrivateKey();
    const path = 'm/webrtc/1';
    const nonce = new Uint8Array(12).fill(3);
    const wg = deriveWg(ctrl, path, nonce);
    const dtls = deriveDtlsSeed(ctrl, path, nonce);
    expect(hx(wg.wgPriv)).not.toEqual(hx(dtls));
  });

  it('derivation is deterministic (same inputs -> same key)', () => {
    const ctrl = secp256k1.utils.randomPrivateKey();
    const nonce = new Uint8Array(12).fill(9);
    expect(hx(deriveDtlsSeed(ctrl, 'm/x/1', nonce))).toEqual(
      hx(deriveDtlsSeed(ctrl, 'm/x/1', nonce)),
    );
  });
});

describe('sealed WebRTC offer envelope', () => {
  it('recipient opens, recovers SDP + fingerprint, verifies signer', async () => {
    const alice = mkIdentity();
    const bob = mkIdentity();
    const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
    const fingerprint = 'sha-256 AA:BB:CC';

    const sealed = await buildSealedOffer({
      kind: 'offer',
      signer: alice.wallet,
      fromAddr: alice.address,
      fromConvPriv: alice.conv,
      toAddr: bob.address,
      toConvPub: bob.convPub,
      sdp,
      fingerprint,
    });

    const opened = await openSealedOffer({
      body: sealed.body,
      myConvPriv: bob.conv,
      fromConvPub: alice.convPub,
      fromAddr: alice.address,
      toAddr: bob.address,
      expectFrom: alice.address,
    });

    expect(opened.kind).toEqual('offer');
    expect(opened.sdp).toEqual(sdp);
    expect(opened.fingerprint).toEqual(fingerprint);
    expect(opened.verifiedFrom.toLowerCase()).toEqual(alice.address.toLowerCase());
  });

  it('rejects a forged sender (MITM)', async () => {
    const alice = mkIdentity();
    const bob = mkIdentity();
    const mallory = mkIdentity();
    const sealed = await buildSealedOffer({
      kind: 'offer',
      signer: alice.wallet,
      fromAddr: alice.address,
      fromConvPriv: alice.conv,
      toAddr: bob.address,
      toConvPub: bob.convPub,
      sdp: 'a=fingerprint:sha-256 AA:BB\r\n',
      fingerprint: 'sha-256 AA:BB',
    });
    // Bob expects it from Mallory -> signature won't recover to Mallory.
    await expect(
      openSealedOffer({
        body: sealed.body,
        myConvPriv: bob.conv,
        fromConvPub: alice.convPub,
        fromAddr: alice.address,
        toAddr: bob.address,
        expectFrom: mallory.address,
      }),
    ).rejects.toThrow(/signature mismatch/);
  });
});

describe('hash + off-chain blob signaling shape', () => {
  it('bodyHash matches the stored blob; store roundtrips', async () => {
    const store = new MemoryBlobStore();
    const alice = mkIdentity();
    const bob = mkIdentity();
    const sealed = await buildSealedOffer({
      kind: 'answer',
      signer: bob.wallet,
      fromAddr: bob.address,
      fromConvPriv: bob.conv,
      toAddr: alice.address,
      toConvPub: alice.convPub,
      sdp: 'a=fingerprint:sha-256 DE:AD\r\n',
      fingerprint: 'sha-256 DE:AD',
    });
    const ref = await store.put(sealed.body);
    const got = await store.get(ref);
    expect(ethers.keccak256(got)).toEqual(sealed.bodyHash);
    expect(hx(ub(sealed.bodyHash))).toEqual(sealed.bodyHash);
  });
});
