// Lobby.tsx — screen 3: contacts / call-a-peer.
//
// - "Call peer" input: @name (via Envio search_profiles_v2) or pasted address.
// - Inbound invites: SessionAnnounced events addressed to me (offers) surface
//   as incoming-call rows. (Full invite registry browse is minimal here; the
//   on-chain event path is wired via watchInbound in the Call screen too.)

import { useEffect, useRef, useState } from 'react';
import { useApp, type CallPeer } from '../state/app';
import { resolveName, type ProfileHit } from '../lib/names';
import { convPubOf } from '../lib/registry';
import { watchInbound, type IncomingSession } from '../lib/signaling';

export function Lobby() {
  const { state, dispatch } = useApp();
  const up = state.up!;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<IncomingSession[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for inbound offers addressed to me.
  useEffect(() => {
    let off: (() => void) | undefined;
    watchInbound(up.address, (s) => {
      if (s.kind === 'offer') setIncoming((prev) => [s, ...prev.filter((p) => p.from !== s.from)]);
    })
      .then((unsub) => {
        off = unsub;
      })
      .catch(() => {
        /* no RegistryV3 yet -> no inbound events; non-fatal */
      });
    return () => off?.();
  }, [up.address]);

  function onQuery(v: string) {
    setQuery(v);
    setErr(null);
    if (debounce.current) clearTimeout(debounce.current);
    if (!v.trim()) {
      setHits([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        setHits(await resolveName(v));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  async function call(hit: ProfileHit) {
    setErr(null);
    try {
      const peerConv = await convPubOf(hit.address);
      if (!peerConv) {
        setErr(`${hit.name ?? hit.address} has not announced a conversation key yet.`);
        return;
      }
      const peer: CallPeer = { address: hit.address, name: hit.name, convPub: peerConv };
      dispatch({ type: 'startCall', peer });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function answer(s: IncomingSession) {
    const peerConv = await convPubOf(s.from);
    if (!peerConv) {
      setErr('Caller has no announced conversation key.');
      return;
    }
    dispatch({ type: 'startCall', peer: { address: s.from, name: null, convPub: peerConv } });
  }

  return (
    <div className="card">
      <h2>Lobby</h2>
      <p className="muted">
        Connected as <code className="mono small">{up.address}</code>
      </p>

      <section>
        <h3>Call a peer</h3>
        <input
          placeholder="@name or 0x address…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {searching && <p className="hint">Searching…</p>}
        <ul className="list">
          {hits.map((h) => (
            <li key={h.address} className="row">
              <span className="grow">
                {h.name ? <strong>@{h.name}</strong> : null}{' '}
                <code className="mono small">{h.address.slice(0, 10)}…{h.address.slice(-4)}</code>
              </span>
              <button onClick={() => call(h)}>Call</button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Incoming</h3>
        {incoming.length === 0 ? (
          <p className="hint">No incoming calls.</p>
        ) : (
          <ul className="list">
            {incoming.map((s) => (
              <li key={s.from + s.threadId} className="row">
                <span className="grow">
                  <code className="mono small">{s.from.slice(0, 10)}…{s.from.slice(-4)}</code>{' '}
                  wants to connect
                </span>
                <button onClick={() => answer(s)}>Answer</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {err && <p className="error">{err}</p>}
    </div>
  );
}
