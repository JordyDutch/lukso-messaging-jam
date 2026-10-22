// Connect.tsx — step 1: connect any Universal Profile via the UP extension.
import { useState } from 'react';
import { useApp } from '../state/app';
import { connectUp } from '../lib/up';
import { initType3Probe } from '../lib/transport';

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
      // Probe blob (Type-3) support in the background; forces text lane if the
      // wallet clearly can't sign Type-3 (the composer surfaces why).
      void initType3Probe(up.eip1193);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center">
      <h1>🌭 UP Dawg</h1>
      <p className="muted">
        A shared wall for Universal Profiles. Post in the clear and tag someone —
        that's public, like a wall post. Or open an encrypted DM with a peer who
        has announced their key — that's private, on-chain, end-to-end sealed.
      </p>
      <button disabled={busy} onClick={onConnect}>
        {busy ? 'Connecting…' : 'Connect Universal Profile'}
      </button>
      {err && <p className="error">{err}</p>}
      <p className="hint">Requires the UP Browser Extension. Connect as any UP.</p>
    </div>
  );
}
