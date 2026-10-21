#!/usr/bin/env bash
# Prove the HKDF-derived X25519 key is a REAL WireGuard key: feed the derived
# private key to the actual `wg` binary and confirm `wg pubkey` produces the
# exact same public key our @noble x25519 computed. If these match, the derived
# material drops straight into a wg config with no translation.
set -euo pipefail
cd "$(dirname "$0")"

read -r PRIV_B64 PUB_HEX < <(node -e '
  import("@noble/curves/ed25519").then(async ({x25519})=>{
    const {hkdf}=await import("@noble/hashes/hkdf");
    const {sha256}=await import("@noble/hashes/sha256");
    const {secp256k1}=await import("@noble/curves/secp256k1");
    const upPriv=secp256k1.utils.randomPrivateKey();
    const nonce=new Uint8Array(16).fill(7);
    const info=new TextEncoder().encode("wg-x25519-v1|m/wg/1");
    const wgPriv=hkdf(sha256,upPriv,nonce,new Uint8Array([...info,...nonce]),32);
    const wgPub=x25519.getPublicKey(wgPriv);
    process.stdout.write(Buffer.from(wgPriv).toString("base64")+" "+Buffer.from(wgPub).toString("hex")+"\n");
  });
')

WG_PUB_B64=$(printf '%s' "$PRIV_B64" | wg pubkey)
WG_PUB_HEX=$(printf '%s' "$WG_PUB_B64" | base64 -d | od -An -v -tx1 | tr -d ' \n')

echo "derived priv (b64) : $PRIV_B64"
echo "our x25519 pub(hex): $PUB_HEX"
echo "wg pubkey     (hex): $WG_PUB_HEX"

if [ "$PUB_HEX" = "$WG_PUB_HEX" ]; then
  echo "✓ MATCH — HKDF-derived key is a valid WireGuard keypair (wg agrees)"
else
  echo "✗ MISMATCH — derived key is NOT wg-compatible"; exit 1
fi
