// FingerprintBadge.tsx — shows the peer's UP-verified DTLS fingerprint status.
//
// Green when the sealed+signed fingerprint matches the negotiated SDP
// fingerprint (identity↔channel binding holds — anti-MITM). Amber while we have
// no answer yet; red on mismatch.

interface Props {
  fingerprint: string | null;
  verified: boolean;
}

export function FingerprintBadge({ fingerprint, verified }: Props) {
  if (!fingerprint) {
    return <span className="badge badge-pending" title="Awaiting peer's signed fingerprint">unverified</span>;
  }
  return (
    <span
      className={verified ? 'badge badge-ok' : 'badge badge-bad'}
      title={fingerprint}
    >
      {verified ? '✓ identity-verified' : '✗ fingerprint mismatch'}
    </span>
  );
}
