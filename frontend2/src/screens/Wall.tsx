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
  postPublicBlob,
  postDm,
  postDmBlob,
  type WallPost,
  type RelayCtx,
  type SignOutcome,
} from '../lib/wall';
import { useTransport } from '../lib/transport';
import { convPubOf } from '../lib/registry';
import { threadIdFor } from '../lib/crypto';
import { resolveName, nameOf, upLabel, type ProfileHit } from '../lib/names';
import { watchRoster, type RosterEntry } from '../lib/roster';
import { EXPLORER, KNOWN_PEERS } from '../lib/config';
import { ethers } from 'ethers';
import {
  P2pDriver,
  startCall,
  answerCall,
  isInboundSignal,
  type P2pStatus,
} from '../lib/p2p';

type Tab =
  | { kind: 'public' }
  | { kind: 'mentions' }
  | { kind: 'people' }
  | { kind: 'dm'; name: string; address: string };

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * useName — reverse-resolve a UP address to its human-readable `name#HASH`
 * label (cached in names.ts). `name#HASH` (e.g. `alice#0F41`) is the LUKSO
 * disambiguation convention: the first 4 hex chars after 0x, uppercased. When
 * the profile has no LSP3 name it falls back to `0xabcd…1234#HASH` so there is
 * always a stable, indexable handle (not just a bare short address). Returns ''
 * for the zero address.
 */
function useName(address: string | null | undefined): string {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setName(null);
    if (address && address !== ZERO) {
      nameOf(address).then((n) => live && setName(n)).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [address]);
  if (!address || address === ZERO) return '';
  return upLabel(address, name);
}

/** Address label that resolves to @name, falling back to a linked short address. */
function Who({ address }: { address: string }) {
  const label = useName(address);
  return (
    <a className="mono" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {label || short(address)}
    </a>
  );
}

export function Wall() {
  const { state, dispatch } = useApp();
  const up = state.up!;

  // Resolve the connected UP's LSP3 name once: `myLabel` is the full name#hash
  // for display, `myRawName` is the bare LSP3 name (or '') embedded in the
  // author proof of relayed posts.
  const myLabel = useName(up.address);
  const [myRawName, setMyRawName] = useState<string>('');
  useEffect(() => {
    let live = true;
    nameOf(up.address).then((n) => live && setMyRawName(n ?? '')).catch(() => {});
    return () => { live = false; };
  }, [up.address]);

  // Relay context for the gas-less blob lane (AUTHOR-SIGNATURE model, Option B,
  // see relay.ts). The dApp never needs the controller EOA: the extension
  // personal_signs a canonical message binding the post to this UP, and the
  // relayer recovers the signer, verifies it controls the UP, and posts the
  // blob as itself with the author proof (UP + name + signature) in `meta`.
  // `upName` is the resolved LSP3 name, carried for display on read. Panes
  // attach their own `onSign` diagnostic so the UI can show exactly what the
  // extension did when asked to sign.
  const relay = useMemo<RelayCtx>(
    () => ({ up: up.address, upName: myRawName }),
    [up, myRawName],
  );

  const [raw, setRaw] = useState<WallPost[]>([]);
  const [decoded, setDecoded] = useState<WallPost[]>([]);
  const [tab, setTab] = useState<Tab>({ kind: 'public' });
  const [peerAnnounced, setPeerAnnounced] = useState<Record<string, boolean>>({});
  const [roster, setRoster] = useState<RosterEntry[]>([]);

  // subscribe to the whole wall once
  useEffect(() => {
    let off: (() => void) | undefined;
    watchWall(setRaw).then((unsub) => (off = unsub)).catch(() => {});
    return () => off?.();
  }, []);

  // subscribe to the announced-UP directory (ConvPubAnnounced) once
  useEffect(() => {
    let off: (() => void) | undefined;
    watchRoster(setRoster).then((unsub) => (off = unsub)).catch(() => {});
    return () => off?.();
  }, []);

  // decode (and decrypt what we can) whenever raw changes.
  //
  // Depend ONLY on `raw` and the UP *address* (a stable string) — NOT on
  // `up.convPriv` (a Uint8Array) or the `up` object, whose references change on
  // every app-context re-render (poller/roster/announce dispatches). A fresh
  // reference each render would re-fire this effect, and its cleanup cancels the
  // in-flight decode (`live=false`) before it reaches setDecoded. A full feed
  // decode is slow (one beacon fetch per blob), so under that thrash it NEVER
  // completes → `decoded` stays empty → the wall shows "No public posts yet"
  // even though every body recovers. The convPriv for a given address is fixed,
  // so reading it fresh inside the effect is safe. (Blank-wall fix 2026-10-22.)
  const convPriv = up.convPriv;
  useEffect(() => {
    // STREAMING decode: decodePosts fires `onPost` as each post decodes
    // (newest-first), so the wall fills in one post at a time instead of
    // appearing all-at-once after a long wait. Each post is merged into
    // `decoded` by id (last-write-wins per id), so the user's own just-posted
    // blob arriving mid-decode simply upserts rather than aborting the pass.
    // Recovered bodies are cached + persisted to localStorage, so re-entering
    // the dApp renders cached posts immediately without re-fetching sidecars.
    // No cleanup cancellation: a superseded pass is cheap (cache hits) and only
    // ever upserts, and posts are append-only so merged state never shrinks.
    const upsert = (p: WallPost) =>
      setDecoded((prev) => {
        const i = prev.findIndex((x) => x.id === p.id);
        if (i === -1) return [...prev, p].sort((a, b) => a.id - b.id);
        const next = prev.slice();
        next[i] = p;
        return next;
      });
    decodePosts(raw, { addr: up.address, convPriv }, upsert)
      .then((d) => {
        const pub = d.filter((x) => !x.encrypted).length;
        console.info(`[wall-read] decodePosts DONE: ${d.length} decoded, ${pub} public`);
      })
      .catch((e) => console.error('[wall-read] decodePosts THREW:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, up.address]);

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

  // Public feed, ordered NEWEST → OLDEST (highest id first) for display.
  const publicFeed = useMemo(() => {
    const f = decoded.filter((p) => !p.encrypted).sort((a, b) => b.id - a.id);
    console.info(`[wall-read] publicFeed render: decoded=${decoded.length} public=${f.length}`);
    return f;
  }, [decoded]);

  // Public posts that @tag the connected UP — "someone mentioned you".
  const mentions = useMemo(
    () => publicFeed.filter((p) => p.tag.toLowerCase() === meLc && p.from.toLowerCase() !== meLc),
    [publicFeed, meLc],
  );

  const dmThread = useMemo(() => {
    if (tab.kind !== 'dm') return [];
    const tid = threadIdFor(up.address, tab.address).toLowerCase();
    return decoded.filter(
      // human DM messages only; P2P signaling envelopes (signal) are hidden here
      // and consumed by the off-chain channel panel instead.
      (p) => p.encrypted && !p.signal && p.threadId.toLowerCase() === tid,
    );
  }, [decoded, tab, up.address]);

  return (
    <div className="wall">
      <aside className="sidebar">
        <div className="me">
          <div className="small muted">connected</div>
          <div className="mono small" title={up.address}>{myLabel || short(up.address)}</div>
          <div className="small">
            {state.announced ? (
              <span className="ok">● key announced</span>
            ) : (
              <button className="link" onClick={() => dispatch({ type: 'needAnnounce' })}>
                announce key →
              </button>
            )}
          </div>
          <TransportToggle />
        </div>
        <nav className="tabs">
          <button
            className={tab.kind === 'public' ? 'tab active' : 'tab'}
            onClick={() => setTab({ kind: 'public' })}
          >
            🧱 Wall (public)
          </button>
          <button
            className={tab.kind === 'mentions' ? 'tab active' : 'tab'}
            onClick={() => setTab({ kind: 'mentions' })}
          >
            @ Mentions
            {mentions.length > 0 && <span className="badge">{mentions.length}</span>}
          </button>
          <button
            className={tab.kind === 'people' ? 'tab active' : 'tab'}
            onClick={() => setTab({ kind: 'people' })}
          >
            🌐 Discover
            {roster.length > 0 && <span className="badge">{roster.length}</span>}
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
          <PublicPane me={meLc} up={up} feed={publicFeed} relay={relay} />
        ) : tab.kind === 'mentions' ? (
          <MentionsPane me={meLc} feed={mentions} />
        ) : tab.kind === 'people' ? (
          <DiscoverPane
            me={meLc}
            roster={roster}
            openDm={(name, address) => setTab({ kind: 'dm', name, address })}
          />
        ) : (
          <DmPane
            up={up}
            peer={tab}
            thread={dmThread}
            allPosts={decoded}
            meAnnounced={state.announced}
            peerAnnounced={!!peerAnnounced[tab.address.toLowerCase()]}
            relay={relay}
          />
        )}
      </section>
    </div>
  );
}

/**
 * TransportToggle — pick the lane for NEW posts. Blob is the default: the body
 * rides in an ephemeral EIP-4844 blob and only its hash is anchored on-chain
 * (cheap, ~18-day body). Text is the legacy calldata+event lane (permanent).
 * Reading always handles both. If the wallet can't sign Type-3, blob is
 * disabled and we explain why.
 */
function TransportToggle() {
  const { transport, setTransport, type3 } = useTransport();
  const blobBlocked = type3 === 'no';
  return (
    <div className="transport small" style={{ marginTop: 8 }}>
      <div className="muted" style={{ marginBottom: 2 }}>transport</div>
      <div className="seg">
        <button
          className={transport === 'blob' ? 'seg-on' : ''}
          disabled={blobBlocked}
          title="Body in an EIP-4844 blob (ephemeral ~18d); only its hash is anchored on-chain. Cheap."
          onClick={() => setTransport('blob')}
        >
          🫧 Blob
        </button>
        <button
          className={transport === 'text' ? 'seg-on' : ''}
          title="Body in calldata + event. Permanent on-chain."
          onClick={() => setTransport('text')}
        >
          📝 Text
        </button>
      </div>
      {blobBlocked && (
        <div className="muted" style={{ marginTop: 4 }}>
          Your wallet can’t sign blob (Type-3) txs yet — using Text. Blob posting
          is pending wallet/relay support.
        </div>
      )}
      {!blobBlocked && transport === 'blob' && (
        <div className="muted" style={{ marginTop: 4 }}>
          Bodies expire (~18d); the hash stays on-chain forever.
        </div>
      )}
    </div>
  );
}

/** A tiny lane badge so you can see which posts rode a blob. */
function LaneBadge({ p }: { p: WallPost }) {
  if (p.lane !== 'blob') return null;
  return (
    <span className="lane-badge small muted" title="posted via EIP-4844 blob (body ephemeral, hash on-chain)">
      🫧 blob
    </span>
  );
}

/** Render a post body, handling an expired (pruned) blob body + locked DMs. */
function Body({ p }: { p: WallPost }) {
  if (p.pruned) {
    return (
      <em className="muted">
        🫧 blob body expired — only its on-chain hash remains
      </em>
    );
  }
  if (p.locked) return <em className="muted">🔒 encrypted — cannot decrypt</em>;
  return <>{p.text}</>;
}

/**
 * SignPanel — SIGNATURE TEST readout. Shows exactly what the UP extension did
 * when asked to sign the LSP25 relay digest: the method tried, the address it
 * signed with, the raw signature, and who it ecrecovers to. This is the one
 * thing only a real browser confirms (relay.ts §SIGNATURE FORMAT). A green
 * "recovered" that equals a controller of the UP means the signature-relay
 * architecture works end-to-end against this extension.
 */
function SignPanel({ outcome }: { outcome: SignOutcome | null }) {
  if (!outcome) return null;
  const row = (k: string, v: string) => (
    <div style={{ display: 'flex', gap: 6, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
      <span className="muted" style={{ minWidth: 92, flexShrink: 0 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div
      className="small"
      style={{
        marginTop: 8, padding: 10, borderRadius: 8,
        border: `1px solid ${outcome.ok ? '#2e7d32' : '#b23'}`,
        background: outcome.ok ? 'rgba(46,125,50,0.08)' : 'rgba(178,51,51,0.08)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {outcome.ok ? '✅ extension signed the LSP25 digest' : '❌ extension did not sign'}
      </div>
      {row('method', outcome.method)}
      {row('signer', outcome.signer)}
      {row('keyManager', outcome.keyManager)}
      {row('nonce', outcome.nonce)}
      {row('digest', outcome.digest)}
      {outcome.signature && row('signature', outcome.signature)}
      {outcome.recovered && row('recovered', outcome.recovered)}
      {outcome.error && row('note', outcome.error)}
    </div>
  );
}

function PublicPane({ me, up, feed, relay }: { me: string; up: ReturnType<typeof useApp>['state']['up']; feed: WallPost[]; relay: RelayCtx }) {
  const [text, setText] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [tag, setTag] = useState<{ label: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<SignOutcome | null>(null);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { transport } = useTransport();

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
    setSig(null);
    try {
      if (transport === 'blob') {
        await postPublicBlob(up!.signer, text.trim(), tag?.address ?? null, { ...relay, onSign: setSig });
      } else {
        await postPublic(up!.signer, text.trim(), tag?.address ?? null);
      }
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
        <SignPanel outcome={sig} />
      </div>

      <ul className="posts">
        {feed.length === 0 && <li className="muted empty">No public posts yet. Be the first.</li>}
        {feed.map((p) => (
          <li key={p.id} className={p.from.toLowerCase() === me ? 'post mine' : 'post'}>
            <div className="posthead">
              <Who address={p.from} />
              {p.tag !== ZERO && (
                <span className={p.tag.toLowerCase() === me ? 'tagged tagme' : 'tagged'}> → <Tag address={p.tag} /></span>
              )}
              <span className="ts">{fmt(p.timestamp)}</span>
              <LaneBadge p={p} />
            </div>
            <div className="body"><Body p={p} /></div>
            <a className="small muted" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">on-chain ↗</a>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Inline @tag label that resolves to @name. */
function Tag({ address }: { address: string }) {
  const label = useName(address);
  return <>{label || short(address)}</>;
}

/**
 * MentionsPane — every public post that @tags the connected UP, newest first.
 * Surfaces "who mentioned you and what they said", with tagger resolved to @name.
 */
function MentionsPane({ me, feed }: { me: string; feed: WallPost[] }) {
  return (
    <>
      <div className="composer">
        <div className="small muted">
          @ Mentions — public posts that tagged you. {feed.length} total.
        </div>
      </div>
      <ul className="posts">
        {feed.length === 0 && (
          <li className="muted empty">No one has mentioned you yet. When a public post @tags your UP, it shows up here.</li>
        )}
        {feed.map((p) => (
          <li key={p.id} className={p.from.toLowerCase() === me ? 'post mine' : 'post'}>
            <div className="posthead">
              <Who address={p.from} />
              <span className="tagged tagme"> → you</span>
              <span className="ts">{fmt(p.timestamp)}</span>
              <LaneBadge p={p} />
            </div>
            <div className="body"><Body p={p} /></div>
            <a className="small muted" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">on-chain ↗</a>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * DiscoverPane — the public directory of UPs that have announced a conversation
 * key (RegistryV3 ConvPubAnnounced). Anyone here is reachable for an encrypted
 * DM / off-chain channel. Name is shown prominently; the UP address and the
 * announced convPub are shown but secondary. Includes a free-text @name/address
 * search so you can jump to anyone, announced or not.
 */
function DiscoverPane({
  me,
  roster,
  openDm,
}: {
  me: string;
  roster: RosterEntry[];
  openDm: (name: string, address: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [searching, setSearching] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onSearch(v: string) {
    setQ(v);
    if (deb.current) clearTimeout(deb.current);
    if (!v.trim()) return setHits([]);
    if (/^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
      setHits([{ address: v.trim(), name: null, avatar: null }]);
      return;
    }
    setSearching(true);
    deb.current = setTimeout(async () => {
      try {
        setHits(await resolveName(v));
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  // Hide yourself from the announced directory.
  const others = roster.filter((r) => r.address.toLowerCase() !== me);

  return (
    <>
      <div className="composer">
        <div className="small muted">
          🌐 Discover — Universal Profiles that announced an encryption key. Anyone
          listed can receive an encrypted DM and an off-chain channel. {others.length} announced.
        </div>
        <input
          className="input"
          placeholder="Search any @name or paste a 0x UP address…"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
        />
        {q.trim() !== '' && (
          <ul className="roster">
            {searching && <li className="muted empty">searching…</li>}
            {!searching && hits.length === 0 && (
              <li className="muted empty">No profile found for “{q}”.</li>
            )}
            {hits.map((h) => (
              <RosterCard
                key={h.address}
                address={h.address}
                presetName={h.name}
                convPub={null}
                openDm={openDm}
              />
            ))}
          </ul>
        )}
      </div>

      <ul className="roster">
        {others.length === 0 && (
          <li className="muted empty">
            No announced profiles in range yet. Once a UP announces its key it appears here —
            or search above to DM anyone directly.
          </li>
        )}
        {others.map((r) => (
          <RosterCard
            key={r.address}
            address={r.address}
            presetName={null}
            convPub={r.convPub}
            openDm={openDm}
          />
        ))}
      </ul>
    </>
  );
}

/** One profile row in the Discover directory / search results. */
function RosterCard({
  address,
  presetName,
  convPub,
  openDm,
}: {
  address: string;
  presetName: string | null;
  convPub: string | null;
  openDm: (name: string, address: string) => void;
}) {
  // Prefer the name the search already gave us; else reverse-resolve.
  const resolved = useName(address);
  const name = presetName ? `@${presetName}` : resolved;
  const display = name || short(address);
  const dmName = (presetName ?? (name.startsWith('@') ? name.slice(1) : '')) || short(address);

  return (
    <li className="rostercard">
      <div className="rosterid">
        <span className="rostername">{display}</span>
        <a
          className="mono small muted"
          href={`${EXPLORER}/address/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          {short(address)} ↗
        </a>
        {convPub && (
          <span className="mono small muted" title={`announced conv pubkey: ${convPub}`}>
            🔑 {short(convPub)}
          </span>
        )}
      </div>
      <button className="btn small" onClick={() => openDm(dmName, address)}>
        🔒 Message
      </button>
    </li>
  );
}

function DmPane({
  up,
  peer,
  thread,
  allPosts,
  meAnnounced,
  peerAnnounced,
  relay,
}: {
  up: ReturnType<typeof useApp>['state']['up'];
  peer: { name: string; address: string };
  thread: WallPost[];
  allPosts: WallPost[];
  meAnnounced: boolean;
  peerAnnounced: boolean;
  relay: RelayCtx;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<SignOutcome | null>(null);
  const ready = meAnnounced && peerAnnounced;
  const { transport } = useTransport();

  async function send() {
    setBusy(true);
    setErr(null);
    setSig(null);
    try {
      const dmArgs = {
        signer: up!.signer,
        myAddr: up!.address,
        myConvPriv: up!.convPriv,
        peerAddr: peer.address,
        text: text.trim(),
      };
      if (transport === 'blob') await postDmBlob({ ...dmArgs, relay: { ...relay, onSign: setSig } });
      else await postDm(dmArgs);
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

      <P2pPanel up={up} peer={peer} allPosts={allPosts} ready={ready} />

      <ul className="posts">
        {thread.length === 0 && <li className="muted empty">No messages in this thread yet.</li>}
        {[...thread].reverse().map((p) => (
          <li key={p.id} className={p.from.toLowerCase() === meLc ? 'post mine' : 'post'}>
            <div className="posthead">
              <span className="mono">{p.from.toLowerCase() === meLc ? 'you' : peer.name}</span>
              <span className="ts">{fmt(p.timestamp)}</span>
            </div>
            <div className="body"><Body p={p} /></div>
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
        <SignPanel outcome={sig} />
      </div>
    </>
  );
}

/**
 * P2pPanel — the off-chain channel, bootstrapped over the encrypted DM.
 *
 * "Go off-chain" posts a sealed WebRTC offer as a Wall DM; the peer's panel sees
 * it in the feed, answers (another DM), and once ICE connects the DataChannel
 * carries chat directly peer-to-peer — no further chain writes. Inbound signaling
 * posts are pulled from the SAME decoded wall feed the DM thread uses, filtered
 * to this peer + the P2P magic, and fed to the driver exactly once each.
 */
function P2pPanel({
  up,
  peer,
  allPosts,
  ready,
}: {
  up: ReturnType<typeof useApp>['state']['up'];
  peer: { name: string; address: string };
  allPosts: WallPost[];
  ready: boolean;
}) {
  const [status, setStatus] = useState<P2pStatus>('idle');
  const [fp, setFp] = useState<string | null>(null);
  const [log, setLog] = useState<{ me: boolean; text: string }[]>([]);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const driverRef = useRef<P2pDriver | null>(null);
  const consumed = useRef<Set<number>>(new Set());

  const common = useMemo(
    () => ({
      signer: up!.signer,
      myAddr: up!.address,
      myConvPriv: up!.convPriv,
      peerAddr: peer.address,
      cb: {
        onStatus: setStatus,
        onMessage: (t: string) => setLog((l) => [...l, { me: false, text: t }]),
        onVerified: (f: string) => setFp(f),
      },
    }),
    [up, peer.address],
  );

  // Reset when switching peer tab.
  useEffect(() => {
    driverRef.current?.hangup();
    driverRef.current = null;
    consumed.current = new Set();
    setStatus('idle');
    setFp(null);
    setLog([]);
    setErr(null);
  }, [peer.address]);

  // Feed inbound signaling DMs (offers/answers) to the driver, once each.
  useEffect(() => {
    const inbound = allPosts.filter((p) => isInboundSignal(p, up!.address, peer.address));
    for (const p of inbound) {
      if (consumed.current.has(p.id)) continue;
      consumed.current.add(p.id);
      const body = ethers.getBytes(p.bodyRaw);
      (async () => {
        try {
          if (!driverRef.current) {
            // No active call: an inbound offer — auto-answer it.
            driverRef.current = await answerCall(common, body);
          } else {
            await driverRef.current.ingest(body);
          }
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })();
    }
  }, [allPosts, common, peer.address, up]);

  async function call() {
    setErr(null);
    try {
      driverRef.current = await startCall(common);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function hangup() {
    driverRef.current?.hangup();
    driverRef.current = null;
  }

  function sendDirect() {
    const t = input.trim();
    if (!t || !driverRef.current) return;
    if (driverRef.current.send(t)) {
      setLog((l) => [...l, { me: true, text: t }]);
      setInput('');
    }
  }

  const connected = status === 'connected';
  const active = status !== 'idle' && status !== 'closed' && status !== 'failed';

  return (
    <div className="p2p">
      <div className="p2phead">
        <span className="small muted">⚡ Off-chain channel (WebRTC, bootstrapped via this encrypted DM)</span>
        <span className={`p2pstatus ${status}`}>{statusLabel(status)}</span>
        {!active ? (
          <button className="link" disabled={!ready} onClick={call} title={ready ? '' : 'both keys must be announced first'}>
            Go off-chain →
          </button>
        ) : (
          <button className="link" onClick={hangup}>Hang up</button>
        )}
      </div>
      {fp && (
        <div className="small mono muted" title="UP-signed DTLS fingerprint, pinned">
          🔐 peer DTLS fp verified: {fp.slice(0, 24)}…
        </div>
      )}
      {err && <p className="error small">{err}</p>}
      {connected && (
        <div className="p2pchat">
          <ul className="p2plog">
            {log.length === 0 && <li className="muted small">Channel open — messages below are direct P2P, no chain.</li>}
            {log.map((m, i) => (
              <li key={i} className={m.me ? 'p2pmsg mine' : 'p2pmsg'}>
                <span className="mono small">{m.me ? 'you' : peer.name}:</span> {m.text}
              </li>
            ))}
          </ul>
          <div className="p2pcompose">
            <input
              placeholder={`Direct message to ${peer.name} (off-chain)…`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendDirect()}
            />
            <button onClick={sendDirect} disabled={!input.trim()}>Send ⚡</button>
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(s: P2pStatus): string {
  switch (s) {
    case 'idle': return 'not connected';
    case 'calling': return 'calling… (offer sent)';
    case 'ringing': return 'answering…';
    case 'connecting': return 'connecting (ICE)…';
    case 'connected': return '● connected (P2P)';
    case 'failed': return 'failed';
    case 'closed': return 'closed';
  }
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmt(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}
