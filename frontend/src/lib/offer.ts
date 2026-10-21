// offer.ts — the signed+sealed WebRTC session offer/answer envelope.
//
// Ported in spirit from lab-crypto.mjs buildOffer/openOffer, but the sealed
// payload now carries a WebRTC SDP + its UP-signed DTLS fingerprint instead of
// a WireGuard endpoint. Because SDP is far larger than the 200 B on-chain cap,
// we DO NOT put the sealed blob on-chain: we announce a hash on-chain and store
// the sealed blob off-chain (see signaling.ts + blobStore.ts). This module only
// builds/verifies the envelope bytes; where they travel is signaling.ts's job.
//
// Envelope plaintext layout (before seal):
//   kind(1)          0x01 = offer, 0x02 = answer
//   fingerprintLen(1)
//   fingerprint(var) ASCII "sha-256 AB:CD:..." exactly as it appears in SDP
//   nonce(12)
//   expiry(5)        unix seconds, big-endian
//   sdpLen(2)        big-endian
//   sdp(var)         UTF-8
//   sig(65)          EIP-191 signature over keccak(everything-before-sig)
//
// The signature binds the UP controller identity to BOTH the SDP and the DTLS
// fingerprint, which is what closes anti-MITM for voice/video (raw WebRTC does
// not authenticate the fingerprint to any identity).

import {
  conversationKey,
  threadIdFor,
  sealBytes,
  openBytes,
  concatBytes,
  enc,
  dec,
  ethers,
  type SignLike,
} from './crypto';

export type OfferKind = 'offer' | 'answer';
const KIND_OFFER = 0x01;
const KIND_ANSWER = 0x02;

export interface SealedEnvelope {
  /** sealed bytes (magic||iv||tag||ct) — stored off-chain */
  body: Uint8Array;
  /** keccak256 of the sealed body — announced on-chain (<=32 B, fits) */
  bodyHash: string;
  nonce: Uint8Array;
  expiry: number;
  threadId: string;
}

export interface OpenedEnvelope {
  kind: OfferKind;
  sdp: string;
  fingerprint: string;
  verifiedFrom: string;
  expiry: number;
}

const u16be = (n: number): Uint8Array => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
const expiryBytes = (unixSec: number): Uint8Array =>
  ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(unixSec), 5));

/**
 * Build a sealed + signed WebRTC offer/answer FROM sender TO recipient, using
 * the real shared conversation key so the recipient can open it.
 */
export async function buildSealedOffer(params: {
  kind: OfferKind;
  signer: SignLike; // UP controller via provider (EIP-191)
  fromAddr: string;
  fromConvPriv: Uint8Array;
  toAddr: string;
  toConvPub: Uint8Array;
  sdp: string;
  fingerprint: string; // "sha-256 AB:CD:..." from the local RTCPeerConnection
  ttlSeconds?: number;
}): Promise<SealedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const expiry = Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 300);
  const fp = enc.encode(params.fingerprint);
  const sdpBytes = enc.encode(params.sdp);

  const core = concatBytes(
    Uint8Array.from([params.kind === 'offer' ? KIND_OFFER : KIND_ANSWER]),
    Uint8Array.from([fp.length]),
    fp,
    nonce,
    expiryBytes(expiry),
    u16be(sdpBytes.length),
    sdpBytes,
  );

  const sig = await params.signer.signMessage(ethers.getBytes(ethers.keccak256(core)));
  const payload = concatBytes(core, ethers.getBytes(sig));

  const threadId = threadIdFor(params.fromAddr, params.toAddr);
  const key = conversationKey(params.fromConvPriv, params.toConvPub, threadId);
  const body = await sealBytes(payload, key);
  const bodyHash = ethers.keccak256(body);
  return { body, bodyHash, nonce, expiry, threadId };
}

/**
 * Recipient: open + verify signature + verify expiry, return the SDP and the
 * UP-bound DTLS fingerprint to pin against the connection.
 */
export async function openSealedOffer(params: {
  body: Uint8Array;
  myConvPriv: Uint8Array;
  fromConvPub: Uint8Array;
  fromAddr: string;
  toAddr: string;
  expectFrom: string;
}): Promise<OpenedEnvelope> {
  const threadId = threadIdFor(params.fromAddr, params.toAddr);
  const key = conversationKey(params.myConvPriv, params.fromConvPub, threadId);
  const payload = await openBytes(params.body, key); // throws on tamper/wrong key

  const sig = ethers.hexlify(payload.subarray(payload.length - 65));
  const core = payload.subarray(0, payload.length - 65);

  const recovered = ethers.verifyMessage(ethers.getBytes(ethers.keccak256(core)), sig);
  if (recovered.toLowerCase() !== ethers.getAddress(params.expectFrom).toLowerCase()) {
    throw new Error(`signature mismatch (MITM?) recovered=${recovered}`);
  }

  let o = 0;
  const kindByte = core[o++];
  const fpLen = core[o++];
  const fingerprint = dec.decode(core.subarray(o, o + fpLen));
  o += fpLen;
  o += 12; // nonce (not needed on open)
  const expiry = Number('0x' + ethers.hexlify(core.subarray(o, o + 5)).slice(2));
  o += 5;
  const sdpLen = (core[o] << 8) | core[o + 1];
  o += 2;
  const sdp = dec.decode(core.subarray(o, o + sdpLen));

  if (expiry < Math.floor(Date.now() / 1000)) throw new Error('offer expired');

  return {
    kind: kindByte === KIND_OFFER ? 'offer' : 'answer',
    sdp,
    fingerprint,
    verifiedFrom: recovered,
    expiry,
  };
}
