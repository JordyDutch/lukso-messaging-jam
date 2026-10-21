// webrtc.ts — browser-native WebRTC transport for the off-chain P2P channel.
//
// Scope here is intentionally the TEXT channel only: one RTCPeerConnection with a
// single ordered DataChannel. Once ICE connects, messages flow peer-to-peer with
// no chain, no gas, no RPC — the chain was only used to *bootstrap* the link
// (see p2p.ts: the signed SDP envelope travels as an encrypted Wall DM).
//
// DTLS fingerprint / anti-MITM: WebRTC authenticates the channel with a DTLS
// cert, but raw WebRTC does not bind that cert to any identity. We close that gap
// exactly like frontend/'s webrtc.ts: read the real fingerprint out of our local
// SDP, have the UP controller EIP-191-sign it inside the sealed offer envelope,
// and have the peer verify the signature binds the fingerprint to the UP address
// before pinning it. A browser cannot import an externally-derived DTLS key, so a
// byte-deterministic cert is not achievable; signing the actual fingerprint gives
// the same identity<->channel binding, which is the real goal.

import { ICE_SERVERS } from './config';

export type ConnState = RTCPeerConnectionState;

export interface PeerHandle {
  pc: RTCPeerConnection;
  /** text channel; present once open (caller creates it, callee receives it) */
  channel: RTCDataChannel | null;
  wireChannel: (ch: RTCDataChannel) => void;
}

export interface PeerCallbacks {
  onState?: (s: ConnState) => void;
  onMessage?: (text: string) => void;
  onChannelOpen?: () => void;
}

/** Generate a session DTLS certificate (random keypair; see file header). */
export function makeCertificate(): Promise<RTCCertificate> {
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

export function createPeer(cert: RTCCertificate, cbs: PeerCallbacks): PeerHandle {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, certificates: [cert] });
  const handle: PeerHandle = { pc, channel: null, wireChannel: () => {} };

  handle.wireChannel = (ch: RTCDataChannel) => {
    handle.channel = ch;
    ch.onopen = () => cbs.onChannelOpen?.();
    ch.onmessage = (e) => cbs.onMessage?.(String(e.data));
  };

  pc.onconnectionstatechange = () => cbs.onState?.(pc.connectionState);
  // Callee path: the channel arrives on the connection.
  pc.ondatachannel = (e) => handle.wireChannel(e.channel);
  return handle;
}

/** Caller side: create the data channel + full (vanilla-ICE) SDP offer. */
export async function makeOffer(handle: PeerHandle): Promise<string> {
  const ch = handle.pc.createDataChannel('text', { ordered: true });
  handle.wireChannel(ch);
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

export function sendText(handle: PeerHandle, text: string): boolean {
  if (handle.channel && handle.channel.readyState === 'open') {
    handle.channel.send(text);
    return true;
  }
  return false;
}

export function teardown(handle: PeerHandle): void {
  try {
    handle.channel?.close();
  } catch {
    /* ignore */
  }
  try {
    handle.pc.close();
  } catch {
    /* ignore */
  }
  handle.channel = null;
}

/**
 * Resolve once ICE gathering finishes so the SDP we seal into the DM already
 * carries all candidates (vanilla ICE — we only get one bootstrap message each
 * way through the chain, so we cannot trickle). Capped at 5s so a stubborn NAT
 * doesn't hang the connect flow.
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
    setTimeout(resolve, 5000);
  });
}
