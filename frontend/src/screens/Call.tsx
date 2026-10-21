// Call.tsx — screen 4: the live call.
//
// Caller flow: create peer -> local media -> makeOffer -> publishSession(offer)
//   -> watch inbound answer -> fetchAndOpenSession -> pin fingerprint ->
//   applyAnswer -> connected.
//
// This is the one path we CANNOT fully exercise in CI (needs two real browsers +
// a deployed RegistryV3). The crypto + signaling encode/decode is unit-tested
// (test/crypto.test.ts); the live connect is marked accordingly in the UI when
// RegistryV3 is absent.

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/app';
import { REGISTRY_V3_DEPLOYED } from '../lib/config';
import { ub } from '../lib/crypto';
import {
  createPeer,
  makeCertificate,
  makeOffer,
  applyAnswer,
  attachLocalMedia,
  fingerprintFromSdp,
  sendText,
  setTrackEnabled,
  teardown,
  type PeerHandle,
  type ConnState,
} from '../lib/webrtc';
import {
  publishSession,
  fetchAndOpenSession,
  watchInbound,
  type IncomingSession,
} from '../lib/signaling';
import { FingerprintBadge } from '../components/FingerprintBadge';

interface ChatLine {
  mine: boolean;
  text: string;
}

export function Call() {
  const { state, dispatch } = useApp();
  const up = state.up!;
  const peer = state.peer!;

  const [conn, setConn] = useState<ConnState>('new');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [peerFingerprint, setPeerFingerprint] = useState<string | null>(null);
  const [fingerprintVerified, setFingerprintVerified] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [status, setStatus] = useState('Initializing…');

  const handleRef = useRef<PeerHandle | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const pinnedFp = useRef<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const cert = await makeCertificate();
        const handle = createPeer(cert, {
          onState: (s) => setConn(s),
          onMessage: (text) => setChat((c) => [...c, { mine: false, text }]),
          onRemoteTrack: (stream) => {
            if (remoteVideo.current) remoteVideo.current.srcObject = stream;
          },
        });
        handleRef.current = handle;

        const localStream = await attachLocalMedia(handle, { audio: true, video: true });
        if (localVideo.current) localVideo.current.srcObject = localStream;

        if (!REGISTRY_V3_DEPLOYED) {
          setStatus(
            'RegistryV3 (SDP/ICE signaling) is not deployed — cannot announce the offer on-chain. ' +
              'Local media + cert + crypto are ready; wire VITE_REGISTRY_ADDRESS to a deployed RegistryV3 to place a real call.',
          );
          return;
        }

        setStatus('Creating offer…');
        const offerSdp = await makeOffer(handle);
        const myFingerprint = fingerprintFromSdp(offerSdp);

        setStatus('Announcing offer on-chain…');
        const signer = up.signer as unknown as Parameters<typeof publishSession>[0]['signer'];
        await publishSession({
          signer,
          blobStore: state.blobStore,
          kind: 'offer',
          fromAddr: up.address,
          fromConvPriv: up.convPriv,
          toAddr: peer.address,
          toConvPub: ub(peer.convPub),
          sdp: offerSdp,
          fingerprint: myFingerprint,
        });

        setStatus('Waiting for answer…');
        unsub = await watchInbound(up.address, async (s: IncomingSession) => {
          if (cancelled || s.kind !== 'answer' || s.from.toLowerCase() !== peer.address.toLowerCase())
            return;
          try {
            const opened = await fetchAndOpenSession({
              incoming: s,
              blobStore: state.blobStore,
              myConvPriv: up.convPriv,
              fromConvPub: ub(peer.convPub),
              myAddr: up.address,
            });
            setPeerFingerprint(opened.fingerprint);
            pinnedFp.current = opened.fingerprint;
            await applyAnswer(handle, opened.sdp);
            // Pin: the answer SDP's fingerprint must equal the UP-signed one.
            setFingerprintVerified(fingerprintFromSdp(opened.sdp) === opened.fingerprint);
            setStatus('Answer applied; connecting P2P…');
          } catch (e) {
            setStatus('Answer error: ' + (e instanceof Error ? e.message : String(e)));
          }
        });
      } catch (e) {
        setStatus('Call error: ' + (e instanceof Error ? e.message : String(e)));
      }
    })();

    return () => {
      cancelled = true;
      unsub?.();
      if (handleRef.current) teardown(handleRef.current);
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send() {
    const h = handleRef.current;
    if (!h || !draft.trim()) return;
    if (sendText(h, draft)) {
      setChat((c) => [...c, { mine: true, text: draft }]);
      setDraft('');
    }
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    if (handleRef.current) setTrackEnabled(handleRef.current, 'audio', next);
  }
  function toggleCam() {
    const next = !camOn;
    setCamOn(next);
    if (handleRef.current) setTrackEnabled(handleRef.current, 'video', next);
  }

  function hangUp() {
    if (handleRef.current) teardown(handleRef.current);
    handleRef.current = null;
    // ephemeral session keys live only in the (now-closed) RTCPeerConnection
    // + local component state, which unmounts here.
    dispatch({ type: 'endCall' });
  }

  return (
    <div className="card call">
      <header className="callhead">
        <div>
          <h2>Call</h2>
          <code className="mono small">{peer.name ? `@${peer.name}` : peer.address}</code>
        </div>
        <FingerprintBadge
          fingerprint={peerFingerprint}
          verified={fingerprintVerified}
        />
        <span className={`state state-${conn}`}>{conn}</span>
      </header>

      <div className="videos">
        <video ref={remoteVideo} autoPlay playsInline className="remote" />
        <video ref={localVideo} autoPlay playsInline muted className="local" />
      </div>

      <p className="status hint">{status}</p>

      <div className="chat">
        {chat.map((l, i) => (
          <div key={i} className={l.mine ? 'line mine' : 'line'}>
            {l.text}
          </div>
        ))}
      </div>

      <div className="controls">
        <input
          value={draft}
          placeholder="Message…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button onClick={send}>Send</button>
        <button onClick={toggleMic}>{micOn ? 'Mute' : 'Unmute'}</button>
        <button onClick={toggleCam}>{camOn ? 'Camera off' : 'Camera on'}</button>
        <button className="danger" onClick={hangUp}>
          Hang up
        </button>
      </div>
    </div>
  );
}
