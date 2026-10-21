// Connect.tsx — screen 1: connect the Universal Profile.

import { useState } from 'react';
import { useApp } from '../state/app';
import { connectUp } from '../lib/up';

export function Connect() {
  const { dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onConnect() {
    setBusy(true);
    setErr(null);
    try {
      const up = await connectUp();
      dispatch({ type: 'connected', up });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center">
      <h1>UP P2P</h1>
      <p className="muted">
        Private peer-to-peer channel — text, voice, video — between two Universal
        Profiles. Identity is your UP; signaling is on-chain; media flows directly
        P2P over WebRTC. No company server in the data path.
      </p>
      <button disabled={busy} onClick={onConnect}>
        {busy ? 'Connecting…' : 'Connect Universal Profile'}
      </button>
      {err && <p className="error">{err}</p>}
      <p className="hint">Requires the UP Browser Extension. No helper, no root.</p>
    </div>
  );
}
