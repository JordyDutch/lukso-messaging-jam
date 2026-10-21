// sdp.ts — shrink a datachannel-only WebRTC SDP so the signed+sealed envelope
// fits a single encrypted Wall DM (on-chain body cap = 1024 bytes).
//
// We only get ONE bootstrap message each direction (through the chain), so the
// SDP must be vanilla-ICE (all candidates inline). A raw Chromium offer is ~660 B
// which, sealed + signed, lands ~880 B — under the cap but with little room. We
// therefore drop lines that the peer's browser does not need verbatim and that we
// can reconstruct deterministically (session o=/s=/t=, default sctp-port /
// max-message-size), and we keep at most the host + first server-reflexive
// candidate. compact() is lossy-but-sufficient; restore() rebuilds a spec-valid
// SDP that setRemoteDescription accepts.
//
// If a future offer still overflows (many candidates / IPv6), compact() throws a
// clear error rather than silently truncating a candidate mid-line.

const DEFAULT_SCTP_PORT = '5000';
const DEFAULT_MAX_MSG = '262144';

interface Parsed {
  fingerprint: string; // value after "a=fingerprint:" e.g. "sha-256 AB:CD:.."
  setup: string; // actpass | active | passive
  iceUfrag: string;
  icePwd: string;
  mid: string;
  candidates: string[]; // raw "candidate:..." strings (without "a=")
}

function parse(sdp: string): Parsed {
  const get = (re: RegExp): string => {
    const m = sdp.match(re);
    if (!m) throw new Error(`SDP missing ${re}`);
    return m[1];
  };
  const candidates: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = line.match(/^a=(candidate:.+)$/);
    if (m) candidates.push(m[1].trim());
  }
  return {
    fingerprint: get(/a=fingerprint:(.+)/),
    setup: get(/a=setup:(\S+)/),
    iceUfrag: get(/a=ice-ufrag:(\S+)/),
    icePwd: get(/a=ice-pwd:(\S+)/),
    mid: (sdp.match(/a=mid:(\S+)/) ?? [, '0'])[1]!,
    candidates,
  };
}

/** Keep the host + first srflx candidate; drop relay/tcp/IPv6 extras. */
function pickCandidates(cands: string[]): string[] {
  const udp = cands.filter((c) => /\budp\b/i.test(c) && !c.includes(':')); // IPv4 udp only
  const host = udp.find((c) => /typ host/.test(c));
  const srflx = udp.find((c) => /typ srflx/.test(c));
  const out = [host, srflx].filter(Boolean) as string[];
  // Fall back to whatever we have if the typed filter found nothing.
  return out.length ? out : udp.slice(0, 2);
}

/**
 * Compact an SDP into a tiny line-delimited record:
 *   F<fingerprint>\nS<setup>\nU<ufrag>\nP<pwd>\nM<mid>\nC<cand>\nC<cand>
 * (plus optional Z<sctp-port> / X<max-msg> only when non-default).
 */
export function compact(sdp: string): string {
  const p = parse(sdp);
  const cands = pickCandidates(p.candidates);
  const lines = [
    `F${p.fingerprint}`,
    `S${p.setup}`,
    `U${p.iceUfrag}`,
    `P${p.icePwd}`,
    `M${p.mid}`,
    ...cands.map((c) => `C${c}`),
  ];
  const sctp = sdp.match(/a=sctp-port:(\S+)/)?.[1];
  const maxMsg = sdp.match(/a=max-message-size:(\S+)/)?.[1];
  if (sctp && sctp !== DEFAULT_SCTP_PORT) lines.push(`Z${sctp}`);
  if (maxMsg && maxMsg !== DEFAULT_MAX_MSG) lines.push(`X${maxMsg}`);
  return lines.join('\n');
}

/** Rebuild a spec-valid datachannel SDP from a compact() record. */
export function restore(rec: string): string {
  const fields: Record<string, string> = {};
  const candidates: string[] = [];
  for (const line of rec.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'C') candidates.push(val);
    else fields[tag] = val;
  }
  const sctp = fields.Z ?? DEFAULT_SCTP_PORT;
  const maxMsg = fields.X ?? DEFAULT_MAX_MSG;
  const mid = fields.M ?? '0';
  const out = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...candidates.map((c) => `a=${c}`),
    `a=ice-ufrag:${fields.U}`,
    `a=ice-pwd:${fields.P}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fields.F}`,
    `a=setup:${fields.S}`,
    `a=mid:${mid}`,
    `a=sctp-port:${sctp}`,
    `a=max-message-size:${maxMsg}`,
  ];
  return out.join('\r\n') + '\r\n';
}
