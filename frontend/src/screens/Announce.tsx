// Announce.tsx — screen 2: one-time publish of the X25519 conversation pubkey.
//
// Users pay their own gas (no gasless relayer yet — flagged in the UI and
// README). If already announced on-chain with the matching key, we skip.

import { useEffect, useState } from 'react';
import { useApp } from '../state/app';
import { announceConvPub, convPubOf } from '../lib/registry';
import { convPubToBytes32 } from '../lib/up';
import { REGISTRY_V3_DEPLOYED } from '../lib/config';

export function Announce() {
  const { state, dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const up = state.up!;
  const myConvPub = convPubToBytes32(up.convPub);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const onchain = await convPubOf(up.address);
        if (live && onchain && onchain.toLowerCase() === myConvPub.toLowerCase()) {
          dispatch({ type: 'announced' });
        }
      } catch {
        /* read failure is non-fatal here; user can still announce */
      } finally {
        if (live) setChecking(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [up.address, myConvPub, dispatch]);

  async function onAnnounce() {
    setBusy(true);
    setErr(null);
    try {
      const hash = await announceConvPub(up.signer, myConvPub);
      setTx(hash);
      dispatch({ type: 'announced' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center">
      <h2>Announce your conversation key</h2>
      <p className="muted">
        One-time onboarding. Publishes your X25519 conversation public key
        on-chain so peers can derive the shared key and decrypt your sealed
        offers. One transaction — <strong>you pay your own gas</strong> (gasless
        LSP25 relay is planned, not wired yet).
      </p>
      <code className="mono small">{myConvPub}</code>
      {checking ? (
        <p className="hint">Checking if already announced…</p>
      ) : (
        <button disabled={busy} onClick={onAnnounce}>
          {busy ? 'Announcing…' : 'Announce on-chain'}
        </button>
      )}
      {tx && <p className="ok">Announced: {tx.slice(0, 18)}…</p>}
      {err && <p className="error">{err}</p>}
      {!REGISTRY_V3_DEPLOYED && (
        <p className="warn">
          Note: WebRTC session signaling needs RegistryV3 (SDP/ICE fields), which
          is not yet deployed. Announce works against the live RegistryV2; calls
          will show a "signaling contract not deployed" notice until then.
        </p>
      )}
    </div>
  );
}
