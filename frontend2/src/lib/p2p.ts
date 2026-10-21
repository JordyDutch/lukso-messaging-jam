// p2p.ts — establish an off-chain WebRTC DataChannel, BOOTSTRAPPED entirely over
// encrypted Wall DMs.
//
// The chain is used only to carry two small sealed messages (offer, answer); once
// ICE connects, all further chat flows directly peer-to-peer over the DataChannel
// — no gas, no RPC, no latency. This is the "off-chain channel established via
// encrypted DM" in one module.
//
// Envelope: a signed WebRTC offer/answer, byte-compatible in spirit with
// frontend/src/lib/offer.ts, but carrying a COMPACTED SDP (sdp.ts) so the whole
// sealed blob fits a single on-chain Wall DM (<=1024 B). Layout before seal:
//   kind(1)            0x01 offer | 0x02 answer
//   fpLen(1) fp(var)   ASCII "sha-256 AB:.." DTLS fingerprint
//   expiry(5)          unix seconds, big-endian
//   sdpLen(2) sdp(var) compacted SDP record (UTF-8)
//   sig(65)            EIP-191 over keccak(everything-before-sig)
// Then sealed to the shared conv key (AES-256-GCM) and prefixed with the ASCII
// magic "p2p1:" so the chat UI can tell a signaling DM from a human message.

import { ethers } from 'ethers';
import {
  conversationKey,
  threadIdFor,
  sealBytes,
  openBytes,
  concatBytes,
  enc,
  dec,
  ub,
  type SignLike,
} from './crypto';
import { convPubOf } from './registry';
import { getReadProvider } from './rpc';
import { postDm, type WallPost } from './wall';
import {
  makeCertificate,
  createPeer,
  makeOffer,
  makeAnswer,
  applyAnswer,
  fingerprintFromSdp,
  sendText,
  teardown,
  type PeerHandle,
  type ConnState,
} from './webrtc';
import { compact, restore } from './sdp';

const KIND_OFFER = 0x01;
const KIND_ANSWER = 0x02;
const TTL_SECONDS = 600; // a signaling envelope is valid 10 min
/** ASCII prefix on the sealed body that marks a DM as P2P signaling, not chat. */
export const P2P_MAGIC = enc.encode('p2p1:');

const u16be = (n: number): Uint8Array => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);

// A Universal Profile is a contract, so a plain-ECDSA signature never recovers to
// the UP address — it recovers to the controller EOA that signed it. The correct
// authenticity check is ERC-1271: ask the UP whether the (hash, sig) pair is valid;
// LSP0 delegates to its LSP6 KeyManager and returns the magic value iff the signer
// is an authorized controller. This survives key rotation and multiple controllers.
const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_ABI = ['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'];

/** Verify `sig` over `hash` is from an authorized controller of UP `upAddr`. */
async function isValidUpSignature(upAddr: string, hash: string, sig: string): Promise<boolean> {
  try {
    const provider = await getReadProvider();
    const up = new ethers.Contract(upAddr, ERC1271_ABI, provider);
    const res: string = await up.isValidSignature(hash, sig);
    return res.toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false;
  }
}
const expiryBytes = (s: number): Uint8Array =>
  ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(s), 5));

function startsWithMagic(body: Uint8Array): boolean {
  if (body.length < P2P_MAGIC.length) return false;
  for (let i = 0; i < P2P_MAGIC.length; i++) if (body[i] !== P2P_MAGIC[i]) return false;
  return true;
}

/** True if a Wall post body is a P2P signaling envelope (cheap, no decrypt). */
export function isP2pSignal(bodyRaw: string): boolean {
  try {
    return startsWithMagic(ethers.getBytes(bodyRaw));
  } catch {
    return false;
  }
}

async function buildEnvelope(args: {
  kind: 'offer' | 'answer';
  signer: SignLike;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  peerConvPub: Uint8Array;
  sdp: string;
  fingerprint: string;
}): Promise<Uint8Array> {
  const fp = enc.encode(args.fingerprint);
  const sdpBytes = enc.encode(args.sdp);
  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const core = concatBytes(
    Uint8Array.from([args.kind === 'offer' ? KIND_OFFER : KIND_ANSWER]),
    Uint8Array.from([fp.length]),
    fp,
    expiryBytes(expiry),
    u16be(sdpBytes.length),
    sdpBytes,
  );
  const sig = await args.signer.signMessage(ethers.getBytes(ethers.keccak256(core)));
  const payload = concatBytes(core, ethers.getBytes(sig));

  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  const key = conversationKey(args.myConvPriv, args.peerConvPub, threadId);
  const sealed = await sealBytes(payload, key);
  return concatBytes(P2P_MAGIC, sealed);
}

export interface OpenedEnvelope {
  kind: 'offer' | 'answer';
  sdp: string; // full, restored SDP ready for setRemoteDescription
  fingerprint: string;
  verifiedFrom: string;
}

async function openEnvelope(args: {
  body: Uint8Array;
  myConvPriv: Uint8Array;
  peerConvPub: Uint8Array;
  myAddr: string;
  peerAddr: string;
}): Promise<OpenedEnvelope> {
  const sealed = args.body.subarray(P2P_MAGIC.length);
  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  const key = conversationKey(args.myConvPriv, args.peerConvPub, threadId);
  const payload = await openBytes(sealed, key); // throws on tamper / wrong key

  const sig = ethers.hexlify(payload.subarray(payload.length - 65));
  const core = payload.subarray(0, payload.length - 65);
  // The signer is the UP's controller EOA (signMessage over the keccak of core).
  const innerHash = ethers.getBytes(ethers.keccak256(core));
  const recovered = ethers.verifyMessage(innerHash, sig);
  // Authenticity = recovered must be an authorized controller of the peer UP.
  // The EIP-191-prefixed hash is what was actually signed; that is what ERC-1271 checks.
  const eip191Hash = ethers.hashMessage(innerHash);
  const ok = await isValidUpSignature(args.peerAddr, eip191Hash, sig);
  if (!ok) {
    throw new Error(`signature not from a controller of ${args.peerAddr} (MITM?) recovered=${recovered}`);
  }

  let o = 0;
  const kindByte = core[o++];
  const fpLen = core[o++];
  const fingerprint = dec.decode(core.subarray(o, o + fpLen));
  o += fpLen;
  const expiry = Number('0x' + ethers.hexlify(core.subarray(o, o + 5)).slice(2));
  o += 5;
  const sdpLen = (core[o] << 8) | core[o + 1];
  o += 2;
  const compactSdp = dec.decode(core.subarray(o, o + sdpLen));
  if (expiry < Math.floor(Date.now() / 1000)) throw new Error('signaling envelope expired');

  return {
    kind: kindByte === KIND_OFFER ? 'offer' : 'answer',
    sdp: restore(compactSdp),
    fingerprint,
    verifiedFrom: recovered,
  };
}

export type P2pStatus =
  | 'idle'
  | 'calling' // offer sent, waiting for answer DM
  | 'ringing' // offer received, answer sent, waiting for ICE
  | 'connecting' // ICE negotiating
  | 'connected' // DataChannel open — off-chain from here
  | 'failed'
  | 'closed';

export interface P2pSession {
  status: P2pStatus;
  peer: string;
  /** send a chat line over the direct DataChannel (returns false if not open) */
  send: (text: string) => boolean;
  /** tear down the connection and wipe ephemeral keys */
  hangup: () => void;
}

export interface P2pCallbacks {
  onStatus?: (s: P2pStatus) => void;
  onMessage?: (text: string) => void;
  /** pinned, UP-verified DTLS fingerprint of the peer (anti-MITM proof) */
  onVerified?: (peerFingerprint: string, peerAddr: string) => void;
}

interface P2pCommon {
  signer: SignLike;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  cb: P2pCallbacks;
}

async function resolvePeerPub(peerAddr: string): Promise<Uint8Array> {
  const hex = await convPubOf(peerAddr);
  if (!hex) throw new Error('peer has not announced a conversation key — cannot establish P2P');
  return ub(hex);
}

/**
 * Map RTCPeerConnection state to our coarse P2pStatus. We deliberately do NOT
 * treat pc state 'connected' as our 'connected' — the DataChannel 'open' event
 * does that, so the UI only unlocks direct chat once the channel can actually
 * carry bytes. pc failure/close still propagate.
 */
function wireState(setStatus: (s: P2pStatus) => void) {
  return (s: ConnState) => {
    if (s === 'failed' || s === 'disconnected') setStatus('failed');
    else if (s === 'closed') setStatus('closed');
  };
}

/**
 * CALLER: create the peer, seal the offer, post it as an encrypted Wall DM, and
 * return a live session. The caller must feed inbound signaling DMs to
 * `handleInbound` (wired by the screen from the Wall watcher).
 */
export async function startCall(common: P2pCommon): Promise<P2pDriver> {
  return P2pDriver.create(common, 'caller');
}

/**
 * CALLEE: when an inbound offer DM arrives, build the peer + answer and post it
 * back. Returns a live session.
 */
export async function answerCall(common: P2pCommon, offerBody: Uint8Array): Promise<P2pDriver> {
  const d = await P2pDriver.create(common, 'callee');
  await d.ingest(offerBody);
  return d;
}

/**
 * Drives one P2P session. Owns the RTCPeerConnection, performs offer/answer over
 * Wall DMs, and exposes send/hangup. `ingest(body)` is fed every inbound P2P DM
 * for this peer (the screen filters by from==peer && isP2pSignal).
 */
export class P2pDriver {
  status: P2pStatus = 'idle';
  private handle!: PeerHandle;
  private peerPub!: Uint8Array;
  private started = false;

  private constructor(private readonly c: P2pCommon) {}

  static async create(c: P2pCommon, role: 'caller' | 'callee'): Promise<P2pDriver> {
    const d = new P2pDriver(c);
    d.peerPub = await resolvePeerPub(c.peerAddr);
    const cert = await makeCertificate();
    d.handle = createPeer(cert, {
      onState: wireState((s) => d.setStatus(s)),
      onMessage: (t) => c.cb.onMessage?.(t),
      onChannelOpen: () => d.setStatus('connected'),
    });
    if (role === 'caller') await d.sendOffer();
    return d;
  }

  private setStatus(s: P2pStatus) {
    this.status = s;
    this.c.cb.onStatus?.(s);
  }

  private async sendOffer() {
    this.setStatus('calling');
    const sdp = await makeOffer(this.handle);
    const fingerprint = fingerprintFromSdp(sdp);
    const body = await buildEnvelope({
      kind: 'offer',
      signer: this.c.signer,
      myAddr: this.c.myAddr,
      myConvPriv: this.c.myConvPriv,
      peerAddr: this.c.peerAddr,
      peerConvPub: this.peerPub,
      sdp: compact(sdp),
      fingerprint,
    });
    await this.postSignal(body);
  }

  /** Post a sealed signaling envelope as an encrypted Wall DM to the peer. */
  private async postSignal(body: Uint8Array) {
    // Wall.postDm seals plaintext; here we already hold sealed bytes, so we send
    // the raw bytes as the DM body via the same contract call path.
    await postDm({
      signer: this.c.signer as unknown as ethers.Signer,
      myAddr: this.c.myAddr,
      myConvPriv: this.c.myConvPriv,
      peerAddr: this.c.peerAddr,
      rawBody: body, // postDm sends rawBody verbatim when provided (see wall.ts)
    });
  }

  /** Feed one inbound P2P signaling DM body (raw on-chain bytes). */
  async ingest(body: Uint8Array): Promise<void> {
    const opened = await openEnvelope({
      body,
      myConvPriv: this.c.myConvPriv,
      peerConvPub: this.peerPub,
      myAddr: this.c.myAddr,
      peerAddr: this.c.peerAddr,
    });
    this.c.cb.onVerified?.(opened.fingerprint, opened.verifiedFrom);

    if (opened.kind === 'offer') {
      if (this.started) return; // ignore dup offers once we've answered
      this.started = true;
      this.setStatus('connecting');
      const answerSdp = await makeAnswer(this.handle, opened.sdp);
      const body2 = await buildEnvelope({
        kind: 'answer',
        signer: this.c.signer,
        myAddr: this.c.myAddr,
        myConvPriv: this.c.myConvPriv,
        peerAddr: this.c.peerAddr,
        peerConvPub: this.peerPub,
        sdp: compact(answerSdp),
        fingerprint: fingerprintFromSdp(answerSdp),
      });
      this.setStatus('ringing');
      await this.postSignal(body2);
      this.setStatus('connecting');
    } else {
      // answer (caller side)
      if (this.started) return;
      this.started = true;
      this.setStatus('connecting');
      await applyAnswer(this.handle, opened.sdp);
    }
  }

  send(text: string): boolean {
    return sendText(this.handle, text);
  }

  hangup(): void {
    teardown(this.handle);
    this.setStatus('closed');
  }
}

/** Does a Wall post belong to a P2P signaling exchange with `peer` (from vantage of `me`)? */
export function isInboundSignal(p: WallPost, me: string, peer: string): boolean {
  return (
    p.encrypted &&
    p.from.toLowerCase() === peer.toLowerCase() &&
    p.tag.toLowerCase() === me.toLowerCase() &&
    isP2pSignal(p.bodyRaw)
  );
}
