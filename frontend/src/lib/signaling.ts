// signaling.ts — orchestrates the on-chain "hash + off-chain blob" signaling.
//
// Publish an offer/answer:
//   1. buildSealedOffer(sdp, fingerprint)  -> { body, bodyHash }
//   2. blobStore.put(body)                 -> blobRef (CID)
//   3. registry.announceSession(to, threadId, bodyHash, blobRef, kind, expiry)
//
// Receive:
//   listen to SessionAnnounced(to = me) -> fetch blob by blobRef ->
//   verify bodyHash matches -> openSealedOffer -> SDP + pinned fingerprint.
//
// ICE candidates follow the same hash+blob shape via announceIce (small, but we
// keep them off-chain too for uniformity and to stay under the body cap).

import { ethers } from 'ethers';
import { buildSealedOffer, openSealedOffer, type OfferKind } from './offer';
import { type BlobStore } from './blobStore';
import { writeRegistry, readRegistry, SESSION_KIND } from './registry';
import { type SignLike } from './crypto';

export interface IncomingSession {
  from: string;
  threadId: string;
  kind: OfferKind;
  bodyHash: string;
  blobRef: string;
  expiry: number;
}

export async function publishSession(args: {
  signer: ethers.Signer & SignLike;
  blobStore: BlobStore;
  kind: OfferKind;
  fromAddr: string;
  fromConvPriv: Uint8Array;
  toAddr: string;
  toConvPub: Uint8Array;
  sdp: string;
  fingerprint: string;
}): Promise<{ txHash: string; blobRef: string; bodyHash: string; threadId: string }> {
  const sealed = await buildSealedOffer({
    kind: args.kind,
    signer: args.signer,
    fromAddr: args.fromAddr,
    fromConvPriv: args.fromConvPriv,
    toAddr: args.toAddr,
    toConvPub: args.toConvPub,
    sdp: args.sdp,
    fingerprint: args.fingerprint,
  });

  const blobRef = await args.blobStore.put(sealed.body);

  const reg = writeRegistry(args.signer);
  const tx = await reg.announceSession(
    args.toAddr,
    sealed.threadId,
    sealed.bodyHash,
    blobRef,
    SESSION_KIND[args.kind],
    sealed.expiry,
  );
  await tx.wait();
  return { txHash: tx.hash, blobRef, bodyHash: sealed.bodyHash, threadId: sealed.threadId };
}

export async function fetchAndOpenSession(args: {
  incoming: IncomingSession;
  blobStore: BlobStore;
  myConvPriv: Uint8Array;
  fromConvPub: Uint8Array;
  myAddr: string;
}): Promise<{ sdp: string; fingerprint: string; verifiedFrom: string }> {
  const body = await args.blobStore.get(args.incoming.blobRef);

  // Integrity: the on-chain hash must match the off-chain blob (prevents a
  // malicious store from swapping the sealed payload).
  const got = ethers.keccak256(body);
  if (got.toLowerCase() !== args.incoming.bodyHash.toLowerCase()) {
    throw new Error('blob hash mismatch vs on-chain announce');
  }

  const opened = await openSealedOffer({
    body,
    myConvPriv: args.myConvPriv,
    fromConvPub: args.fromConvPub,
    fromAddr: args.incoming.from,
    toAddr: args.myAddr,
    expectFrom: args.incoming.from,
  });
  return { sdp: opened.sdp, fingerprint: opened.fingerprint, verifiedFrom: opened.verifiedFrom };
}

/** Subscribe to inbound SessionAnnounced events addressed to `me`. */
export async function watchInbound(
  me: string,
  cb: (s: IncomingSession) => void,
): Promise<() => void> {
  const reg = await readRegistry();
  const filter = reg.filters.SessionAnnounced(null, me);
  const handler = (
    from: string,
    _to: string,
    threadId: string,
    bodyHash: string,
    blobRef: string,
    kind: bigint,
    expiry: bigint,
  ) => {
    cb({
      from: ethers.getAddress(from),
      threadId,
      kind: Number(kind) === SESSION_KIND.offer ? 'offer' : 'answer',
      bodyHash,
      blobRef,
      expiry: Number(expiry),
    });
  };
  await reg.on(filter, handler);
  return () => {
    reg.off(filter, handler);
  };
}
