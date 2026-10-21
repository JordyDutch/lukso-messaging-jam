// Announce.tsx — step 2: publish my X25519 conversation pubkey on-chain.
// Required before I can SEND or RECEIVE encrypted DMs. Public wall posts do not
// need this — so we let the user skip straight to the wall for public posting,
// but encrypted DM compose stays locked until announced.
import { useEffect, useState } from 'react';
import { useApp } from '../state/app';
import { announceConvPub, convPubOf } from '../lib/registry';
import { convPubToBytes32 } from '../lib/up';
import { EXPLORER } from '../lib/config';

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
        /* non-fatal */
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
        One-time onboarding for <b>encrypted DMs</b>. Publishes your X25519
        conversation public key on-chain so peers can derive the shared key and
        decrypt your sealed messages. You sign once in the extension; nothing is
        stored. You pay a small amount of gas.
      </p>
      <p className="mono small">UP: {up.address}</p>
      <p className="mono small">convPub: {myConvPub}</p>
      {checking ? (
        <p className="hint">Checking on-chain…</p>
      ) : (
        <button disabled={busy} onClick={onAnnounce}>
          {busy ? 'Announcing…' : 'Announce key'}
        </button>
      )}
      {tx && (
        <p className="hint">
          Announced:{' '}
          <a href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">
            {tx.slice(0, 10)}…
          </a>
        </p>
      )}
      {err && <p className="error">{err}</p>}
      <button className="link" onClick={() => dispatch({ type: 'goWall' })}>
        Skip for now (public posts only) →
      </button>
    </div>
  );
}
