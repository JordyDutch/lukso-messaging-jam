// SignProgress.tsx — the dancing-hotdog signing indicator.
//
// Replaces the old raw "✅ extension signed the LSP25 digest" debug readout
// (which, besides being developer noise, referenced SignOutcome fields that
// don't exist). Instead a compact DawgSpinner mascot narrates the real phases
// of a blob post in plain language:
//
//   signing  → the hotdog spins, amber: "waiting for your extension to sign"
//   relaying → it keeps spinning and warms toward green: "posting to chain".
//              After ~15s a calm "taking a while — it'll land, keep browsing"
//              note appears (the tx mines async; we don't abandon the promise,
//              but the UI stops looking frozen).
//   done     → it snaps green and BLASTS (🎉 / 🌭) — the blob landed.
//   error    → red, with the message.
//
// Three clicks on the hotdog reveal a tidy details panel (method / signer /
// recovered / signature) for the curious — the debug info is still there,
// just no longer shoved in everyone's face.
import { useEffect, useRef, useState } from 'react';
import type { SignOutcome } from '../lib/wall';

export type SignPhase = 'idle' | 'signing' | 'relaying' | 'done' | 'error';

/** Compact mascot head-in-bun that spins while working and blasts when done. */
function DawgSpinner({ phase, size = 56 }: { phase: SignPhase; size?: number }) {
  return (
    <div className={`dawgspin dawgspin-${phase}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="sp-bun" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6c177" />
            <stop offset="1" stopColor="#e09e4b" />
          </linearGradient>
          <linearGradient id="sp-fur" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#caa06a" />
            <stop offset="1" stopColor="#a97d44" />
          </linearGradient>
        </defs>
        {/* blast rays — only visible on `done` via CSS */}
        <g className="sp-blast" stroke="#ff4785" strokeWidth="4" strokeLinecap="round">
          <path d="M60 8 L60 20" />
          <path d="M60 100 L60 112" />
          <path d="M8 60 L20 60" />
          <path d="M100 60 L112 60" />
          <path d="M22 22 L31 31" />
          <path d="M98 22 L89 31" />
          <path d="M22 98 L31 89" />
          <path d="M98 98 L89 89" />
        </g>
        {/* the spinning hotdog body */}
        <g className="sp-body">
          <rect x="28" y="70" width="64" height="16" rx="8" fill="url(#sp-bun)" />
          <rect x="32" y="60" width="56" height="16" rx="8" className="sp-weiner" />
          <rect x="28" y="54" width="64" height="13" rx="6" fill="url(#sp-bun)" />
          {/* dog head */}
          <g>
            <path d="M36 30 q-9 2 -7 18 q9 -2 9 -14 Z" fill="#8a5c34" />
            <path d="M84 30 q9 2 7 18 q-9 -2 -9 -14 Z" fill="#8a5c34" />
            <circle cx="60" cy="38" r="22" fill="url(#sp-fur)" />
            <ellipse cx="60" cy="45" rx="12" ry="9" fill="#e8cda0" />
            <circle cx="60" cy="40" r="3.2" fill="#2a2a2a" />
            <circle cx="51" cy="33" r="3" fill="#2a2a2a" />
            <path d="M65 33 q4 -2 8 0" stroke="#2a2a2a" strokeWidth="3" strokeLinecap="round" fill="none" />
            <path d="M57 50 q3 6 6 0 Z" fill="#ff6b81" />
          </g>
        </g>
      </svg>
    </div>
  );
}

const LABEL: Record<SignPhase, string> = {
  idle: '',
  signing: 'Sniffing for your signature… approve it in your UP extension 🐾',
  relaying: 'Signed! Sending your bark to the chain…',
  done: 'Posted! It’s on-chain forever. 🌭',
  error: 'Hmm, that didn’t go through.',
};

/**
 * SignProgress — the whole affordance. Pass the live `phase`, the last
 * SignOutcome (for the tap-to-reveal details), and an error string if any.
 * Renders nothing while idle.
 */
export function SignProgress({
  phase,
  outcome,
  error,
}: {
  phase: SignPhase;
  outcome: SignOutcome | null;
  error?: string | null;
}) {
  const [taps, setTaps] = useState(0);
  const [slow, setSlow] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Item 1: after ~15s of relaying, reassure the user it's gone async.
  useEffect(() => {
    if (slowTimer.current) clearTimeout(slowTimer.current);
    setSlow(false);
    if (phase === 'relaying') {
      slowTimer.current = setTimeout(() => setSlow(true), 15000);
    }
    return () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [phase]);

  // Reset the 3-tap counter whenever a fresh attempt starts.
  useEffect(() => {
    if (phase === 'signing') setTaps(0);
  }, [phase]);

  if (phase === 'idle') return null;

  const working = phase === 'signing' || phase === 'relaying';
  const showDetails = taps >= 3 && !!outcome;

  return (
    <div className={`signprog signprog-${phase}`}>
      <button
        type="button"
        className="signprog-tap"
        title="Tap 3× for the nerdy signature details"
        onClick={() => working && setTaps((t) => t + 1)}
      >
        <DawgSpinner phase={phase} />
      </button>
      <div className="signprog-body">
        <div className="signprog-label">
          {phase === 'error' ? LABEL.error : LABEL[phase]}
        </div>
        {phase === 'relaying' && slow && (
          <div className="signprog-slow small muted">
            Still mining — this can take ~30s on LUKSO. It’ll land; feel free to
            keep browsing, we’ll flip it green when it’s in. ⛏️
          </div>
        )}
        {phase === 'error' && error && (
          <div className="signprog-err small">{error}</div>
        )}
        {working && !showDetails && (
          <div className="signprog-hint small muted">
            (tap the dawg 3× for signature details)
          </div>
        )}
        {showDetails && outcome && <Details outcome={outcome} />}
      </div>
    </div>
  );
}

/** The tidy, tap-to-reveal signature readout — real SignOutcome fields only. */
function Details({ outcome }: { outcome: SignOutcome }) {
  const row = (k: string, v?: string) =>
    v ? (
      <div className="signprog-row">
        <span className="muted">{k}</span>
        <span className="mono">{v}</span>
      </div>
    ) : null;
  return (
    <div className="signprog-details small">
      <div className="signprog-dhead">
        {outcome.ok ? '🔏 Signature verified' : '⚠️ Signature issue'}
      </div>
      {row('method', outcome.method)}
      {row('signer', outcome.signer)}
      {row('recovered', outcome.recovered)}
      {row('signature', outcome.signature)}
      {row('note', outcome.error)}
    </div>
  );
}
