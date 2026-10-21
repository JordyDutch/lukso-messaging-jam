// Wall.tsx — the feed + composer. Two modes:
//   * Public  : plaintext post, optional @tag (mention a UP). Visible to all.
//   * DM       : encrypted post to a chosen peer; threaded; locked until both
//                sides announced their conv key.
//
// Left: tabs = "Wall" (public feed) + one tab per peer (DM thread).
// Right: the selected feed/thread + a composer appropriate to the tab.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/app';
import {
  watchWall,
  decodePosts,
  postPublic,
  postDm,
  type WallPost,
} from '../lib/wall';
import { convPubOf } from '../lib/registry';
import { threadIdFor } from '../lib/crypto';
import { resolveName, type ProfileHit } from '../lib/names';
import { EXPLORER, KNOWN_PEERS } from '../lib/config';

type Tab = { kind: 'public' } | { kind: 'dm'; name: string; address: string };

export function Wall() {
  const { state, dispatch } = useApp();
  const up = state.up!;
  const [raw, setRaw] = useState<WallPost[]>([]);
  const [decoded, setDecoded] = useState<WallPost[]>([]);
  const [tab, setTab] = useState<Tab>({ kind: 'public' });
  const [peerAnnounced, setPeerAnnounced] = useState<Record<string, boolean>>({});

  // subscribe to the whole wall once
  useEffect(() => {
    let off: (() => void) | undefined;
    watchWall(setRaw).then((unsub) => (off = unsub)).catch(() => {});
    return () => off?.();
  }, []);

  // decode (and decrypt what we can) whenever raw changes
  useEffect(() => {
    let live = true;
    decodePosts(raw, { addr: up.address, convPriv: up.convPriv }).then((d) => {
      if (live) setDecoded(d);
    });
    return () => {
      live = false;
    };
  }, [raw, up.address, up.convPriv]);

  // check announce status for known peers (for DM gating)
  useEffect(() => {
    KNOWN_PEERS.forEach(async (p) => {
      try {
        const v = await convPubOf(p.address);
        setPeerAnnounced((s) => ({ ...s, [p.address.toLowerCase()]: !!v }));
      } catch {
        /* ignore */
      }
    });
  }, []);

  const meLc = up.address.toLowerCase();

  const publicFeed = useMemo(
    () => decoded.filter((p) => !p.encrypted),
    [decoded],
  );

  const dmThread = useMemo(() => {
    if (tab.kind !== 'dm') return [];
    const tid = threadIdFor(up.address, tab.address).toLowerCase();
    return decoded.filter(
      (p) => p.encrypted && p.threadId.toLowerCase() === tid,
    );
  }, [decoded, tab, up.address]);

  return (
    <div className="wall">
      <aside className="sidebar">
        <div className="me">
          <div className="small muted">connected</div>
          <div className="mono small">{short(up.address)}</div>
          <div className="small">
            {state.announced ? (
              <span className="ok">● key announced</span>
            ) : (
              <button className="link" onClick={() => dispatch({ type: 'needAnnounce' })}>
                announce key →
              </button>
            )}
          </div>
        </div>
        <nav className="tabs">
          <button
            className={tab.kind === 'public' ? 'tab active' : 'tab'}
            onClick={() => setTab({ kind: 'public' })}
          >
            🧱 Wall (public)
          </button>
          {KNOWN_PEERS.map((p) => (
            <button
              key={p.address}
              className={tab.kind === 'dm' && tab.address === p.address ? 'tab active' : 'tab'}
              onClick={() => setTab({ kind: 'dm', name: p.name, address: p.address })}
            >
              🔒 DM {p.name}
            </button>
          ))}
        </nav>
      </aside>

      <section className="feed">
        {tab.kind === 'public' ? (
          <PublicPane me={meLc} up={up} feed={publicFeed} />
        ) : (
          <DmPane
            up={up}
            peer={tab}
            thread={dmThread}
            meAnnounced={state.announced}
            peerAnnounced={!!peerAnnounced[tab.address.toLowerCase()]}
          />
        )}
      </section>
    </div>
  );
}

function PublicPane({ me, up, feed }: { me: string; up: ReturnType<typeof useApp>['state']['up']; feed: WallPost[] }) {
  const [text, setText] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [tag, setTag] = useState<{ label: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onTag(v: string) {
    setTagInput(v);
    setTag(null);
    if (deb.current) clearTimeout(deb.current);
    if (!v.trim()) return setHits([]);
    if (/^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
      setTag({ label: short(v.trim()), address: v.trim() });
      setHits([]);
      return;
    }
    deb.current = setTimeout(async () => {
      try {
        setHits(await resolveName(v));
      } catch {
        setHits([]);
      }
    }, 300);
  }

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      await postPublic(up!.signer, text.trim(), tag?.address ?? null);
      setText('');
      setTagInput('');
      setTag(null);
      setHits([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="composer">
        <div className="small muted">Public post — visible to everyone on-chain.</div>
        <textarea
          placeholder="What's on your mind?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1024}
        />
        <div className="tagrow">
          <input
            placeholder="tag a UP (optional): @name or 0x…"
            value={tagInput}
            onChange={(e) => onTag(e.target.value)}
          />
          {tag && <span className="pill">@{tag.label} ✕ <button className="link" onClick={() => { setTag(null); setTagInput(''); }}>clear</button></span>}
        </div>
        {hits.length > 0 && (
          <ul className="hits">
            {hits.map((h) => (
              <li key={h.address}>
                <button className="link" onClick={() => { setTag({ label: h.name ?? short(h.address), address: h.address }); setHits([]); setTagInput(h.name ?? h.address); }}>
                  {h.name ? '@' + h.name : short(h.address)} — {short(h.address)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button disabled={busy || !text.trim()} onClick={send}>
          {busy ? 'Posting…' : 'Post publicly'}
        </button>
        {err && <p className="error">{err}</p>}
      </div>

      <ul className="posts">
        {feed.length === 0 && <li className="muted empty">No public posts yet. Be the first.</li>}
        {[...feed].reverse().map((p) => (
          <li key={p.id} className={p.from.toLowerCase() === me ? 'post mine' : 'post'}>
            <div className="posthead">
              <a className="mono" href={`${EXPLORER}/address/${p.from}`} target="_blank" rel="noreferrer">{short(p.from)}</a>
              {p.tag !== '0x0000000000000000000000000000000000000000' && (
                <span className="tagged"> → @{short(p.tag)}</span>
              )}
              <span className="ts">{fmt(p.timestamp)}</span>
            </div>
            <div className="body">{p.text}</div>
            <a className="small muted" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">on-chain ↗</a>
          </li>
        ))}
      </ul>
    </>
  );
}

function DmPane({
  up,
  peer,
  thread,
  meAnnounced,
  peerAnnounced,
}: {
  up: ReturnType<typeof useApp>['state']['up'];
  peer: { name: string; address: string };
  thread: WallPost[];
  meAnnounced: boolean;
  peerAnnounced: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = meAnnounced && peerAnnounced;

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      await postDm({
        signer: up!.signer,
        myAddr: up!.address,
        myConvPriv: up!.convPriv,
        peerAddr: peer.address,
        text: text.trim(),
      });
      setText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const meLc = up!.address.toLowerCase();

  return (
    <>
      <div className="dmhead">
        <h3>🔒 DM with {peer.name}</h3>
        <div className="small mono">{short(peer.address)}</div>
        <div className="small">
          {meAnnounced ? <span className="ok">● you announced</span> : <span className="warn">● you haven't announced</span>}
          {'  '}
          {peerAnnounced ? <span className="ok">● {peer.name} announced</span> : <span className="warn">● {peer.name} hasn't announced</span>}
        </div>
      </div>

      <ul className="posts">
        {thread.length === 0 && <li className="muted empty">No messages in this thread yet.</li>}
        {[...thread].reverse().map((p) => (
          <li key={p.id} className={p.from.toLowerCase() === meLc ? 'post mine' : 'post'}>
            <div className="posthead">
              <span className="mono">{p.from.toLowerCase() === meLc ? 'you' : peer.name}</span>
              <span className="ts">{fmt(p.timestamp)}</span>
            </div>
            <div className="body">{p.locked ? <em className="muted">🔒 encrypted — cannot decrypt</em> : p.text}</div>
            <a className="small muted" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">on-chain ↗</a>
          </li>
        ))}
      </ul>

      <div className="composer">
        {!ready && (
          <p className="warn small">
            Encrypted DM is locked until both parties announce their conversation key.
            {!meAnnounced && ' Announce yours from the sidebar.'}
            {!peerAnnounced && ` ${peer.name} must connect and announce too.`}
          </p>
        )}
        <textarea
          placeholder={ready ? `Encrypted message to ${peer.name}…` : 'Locked until both keys announced'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!ready}
          maxLength={800}
        />
        <button disabled={!ready || busy || !text.trim()} onClick={send}>
          {busy ? 'Sealing & posting…' : '🔒 Send encrypted'}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    </>
  );
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmt(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}
