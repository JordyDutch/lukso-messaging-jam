# PoC: UP-identity-gated ephemeral WireGuard handshake

Proves the crypto layer of the **up-wireguard-lobby** design: a LUKSO Universal
Profile (secp256k1 controller key) authorizes and derives a **fresh ephemeral
WireGuard (X25519) key**, and two UPs exchange a signed+encrypted connection
offer that is immune to MITM. Isolated — no network, no chain calls, no infra
touched. NAT traversal and actually raising `wg` are out of scope here.

## Run
```bash
cd ..                      # poc/ (has node_modules: ethers, @noble/*)
node up-wg-handshake/handshake.mjs
./up-wg-handshake/verify-wg-interop.sh
```

## What each proves

`handshake.mjs` — full A↔B handshake:
- **Derivation (not conversion):** `WG_priv = clamp(HKDF-SHA256(ikm=UP_priv, salt=nonce, info="wg-x25519-v1"|path))`. secp256k1 private key as seed → X25519 WG key. You cannot convert the *curve*; you derive a separate key from the private *seed*. Deterministic → wallet regenerates WG key with zero stored state.
- **Authenticity (anti-MITM):** offer signed EIP-191 by the UP key; verifier **recomputes the digest from received fields** (never trusts a sent digest) and recovers the signer.
- **Confidentiality:** endpoint (the only must-not-leak field) ECIES-encrypted to the recipient UP's secp256k1 pubkey. Everything else (wgPub, path, nonce) is public and safe on-chain.
- **Adversarial checks all REJECTED:** tampered wgPub, forged from-address, wrong-recipient decrypt, expired offer.

`verify-wg-interop.sh` — feeds the derived private key to the real `wg` binary and confirms `wg pubkey` equals our computed X25519 pubkey. **MATCH** ⇒ the derived material is a valid WireGuard keypair with no translation.

## How it maps on-chain (next steps, not in this PoC)
- The `offer` object is exactly what rides in **LSP8 token metadata** — sending the token = the "follow"/lobby-entry signal, caught by the recipient's **Universal Receiver Delegate** (URD), which enforces the 3 access modes (private / follow-gated / open).
- Recipient secp256k1 **pubkey** needed for ECIES is recoverable from the sender's first on-chain LSP8 signature (every transfer is a signed tx).
- LSP6 KeyManager exposes the controller map; user/mobile app picks the "encryption controller".
- Still open: **NAT traversal** (needs public IP or light STUN), defensive gas-bounded URD, replay/TTL enforcement on-chain.

See workspace memory `up-wireguard-lobby` for the full design + trade-offs.
