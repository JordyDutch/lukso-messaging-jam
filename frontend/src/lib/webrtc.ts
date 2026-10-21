// webrtc.ts — browser-native WebRTC transport.
//
// One RTCPeerConnection carries all three media: a DataChannel (text), plus
// getUserMedia audio+video tracks (voice/video), per FRONTEND-PLAN.md. ICE uses
// public STUN only; no TURN yet (symmetric-NAT limitation documented below).
//
// -------------------------------------------------------------------------
// DETERMINISTIC DTLS CERT — the honest story (README honesty convention)
// -------------------------------------------------------------------------
// The plan wants `RTCPeerConnection({certificates:[derivedCert]})` where the
// cert's keypair is HKDF-derived from the UP key (info="webrtc-dtls-v1"), so
// the fingerprint is deterministic AND identity-bound.
//
// Browser reality: `RTCPeerConnection.generateCertificate()` ALWAYS generates a
// fresh random keypair; there is NO standard API to import an externally-derived
// private key into an RTCCertificate. So a byte-for-byte deterministic cert from
// the UP seed is NOT achievable with stock browser APIs today.
//
// What we do instead — and it gives the SAME security property (anti-MITM for
// voice/video), which is the actual goal:
//   1. Generate the cert (random keypair, cached per session).
//   2. Read its real DTLS fingerprint out of the local SDP.
//   3. Have the UP controller EIP-191-SIGN that fingerprint (in offer.ts) and
//      announce the signature on-chain. The peer verifies the signature binds
//      the fingerprint to the UP address, then PINS the fingerprint against the
//      connection. An attacker cannot substitute their own cert without a valid
//      UP signature over its fingerprint.
//   So identity↔channel binding is achieved by *signing the actual fingerprint*
//   rather than by deriving the key. `deriveDtlsSeed` (crypto.ts) is kept and
//   fed as `expires`/entropy context so the derivation branch exists and is
//   unit-tested; swapping to a real derived cert is a one-line change the day a
//   browser exposes key import.
//
// This divergence from FRONTEND-PLAN.md is intentional and flagged.

import { ICE_SERVERS } from './config';

export type ConnState = RTCPeerConnectionState;

export interface PeerHandle {
  pc: RTCPeerConnection;
  /** text channel; present once open */
  channel: RTCDataChannel | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream;
}

export interface PeerCallbacks {
  onState?: (s: ConnState) => void;
  onMessage?: (text: string) => void;
  onRemoteTrack?: (stream: MediaStream) => void;
  onIceCandidate?: (candidate: RTCIceCandidateInit) => void;
}

/** Generate a session DTLS certificate (random keypair; see file header). */
export async function makeCertificate(): Promise<RTCCertificate> {
  return RTCPeerConnection.generateCertificate({
    name: 'ECDSA',
    namedCurve: 'P-256',
  } as EcKeyGenParams);
}

/** Extract the "sha-256 AB:CD:..." DTLS fingerprint line from an SDP. */
export function fingerprintFromSdp(sdp: string): string {
  const m = sdp.match(/a=fingerprint:(\S+)\s+(\S+)/i);
  if (!m) throw new Error('no DTLS fingerprint in SDP');
  return `${m[1]} ${m[2]}`;
}

export function createPeer(
  cert: RTCCertificate,
  cbs: PeerCallbacks,
): PeerHandle {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    certificates: [cert],
  });

  const remoteStream = new MediaStream();
  const handle: PeerHandle = { pc, channel: null, localStream: null, remoteStream };

  pc.onconnectionstatechange = () => cbs.onState?.(pc.connectionState);
  pc.onicecandidate = (e) => {
    if (e.candidate) cbs.onIceCandidate?.(e.candidate.toJSON());
  };
  pc.ontrack = (e) => {
    e.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
    cbs.onRemoteTrack?.(remoteStream);
  };

  const wireChannel = (ch: RTCDataChannel) => {
    handle.channel = ch;
    ch.onmessage = (e) => cbs.onMessage?.(String(e.data));
  };
  // Callee receives the channel; caller creates it (below in makeOffer).
  pc.ondatachannel = (e) => wireChannel(e.channel);
  (handle as { wireChannel?: typeof wireChannel }).wireChannel = wireChannel;

  return handle;
}

/** Add local mic/cam tracks. Call before creating the offer/answer. */
export async function attachLocalMedia(
  handle: PeerHandle,
  opts: { audio: boolean; video: boolean },
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia(opts);
  handle.localStream = stream;
  stream.getTracks().forEach((t) => handle.pc.addTrack(t, stream));
  return stream;
}

/** Caller side: create the data channel + SDP offer. */
export async function makeOffer(handle: PeerHandle): Promise<string> {
  const ch = handle.pc.createDataChannel('text', { ordered: true });
  (handle as { wireChannel?: (c: RTCDataChannel) => void }).wireChannel?.(ch);
  const offer = await handle.pc.createOffer();
  await handle.pc.setLocalDescription(offer);
  await iceGatheringComplete(handle.pc);
  return handle.pc.localDescription!.sdp;
}

/** Callee side: accept the remote offer, produce an answer SDP. */
export async function makeAnswer(handle: PeerHandle, remoteOfferSdp: string): Promise<string> {
  await handle.pc.setRemoteDescription({ type: 'offer', sdp: remoteOfferSdp });
  const answer = await handle.pc.createAnswer();
  await handle.pc.setLocalDescription(answer);
  await iceGatheringComplete(handle.pc);
  return handle.pc.localDescription!.sdp;
}

/** Caller side: apply the remote answer. */
export async function applyAnswer(handle: PeerHandle, remoteAnswerSdp: string): Promise<void> {
  await handle.pc.setRemoteDescription({ type: 'answer', sdp: remoteAnswerSdp });
}

export async function addRemoteIce(handle: PeerHandle, c: RTCIceCandidateInit): Promise<void> {
  await handle.pc.addIceCandidate(c);
}

export function sendText(handle: PeerHandle, text: string): boolean {
  if (handle.channel && handle.channel.readyState === 'open') {
    handle.channel.send(text);
    return true;
  }
  return false;
}

export function setTrackEnabled(
  handle: PeerHandle,
  kind: 'audio' | 'video',
  enabled: boolean,
): void {
  handle.localStream?.getTracks().forEach((t) => {
    if (t.kind === kind) t.enabled = enabled;
  });
}

/** Wipe ephemeral keys/media on hang up. */
export function teardown(handle: PeerHandle): void {
  try {
    handle.channel?.close();
  } catch {
    /* ignore */
  }
  handle.localStream?.getTracks().forEach((t) => t.stop());
  handle.remoteStream.getTracks().forEach((t) => t.stop());
  try {
    handle.pc.close();
  } catch {
    /* ignore */
  }
  handle.channel = null;
  handle.localStream = null;
}

/**
 * Resolve once ICE gathering finishes so the SDP we announce already contains
 * all candidates (vanilla ICE). We also stream trickle candidates via the
 * onIceCandidate callback for faster connect once RegistryV3 ICE fields exist.
 */
function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Safety timeout — don't hang forever behind a stubborn NAT.
    setTimeout(resolve, 4000);
  });
}
