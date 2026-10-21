# PoC: UP-identity-gated ephemeral WireGuard handshake

Proves the crypto layer of the **up-wireguard-lobby** design: a LUKSO Universal
Profile (secp256k1 controller key) authorizes and derives a **fresh ephemeral
WireGuard (X25519) key**, and two UPs exchange a signed+encrypted connection
offer that is immune to MITM. Isolated — no network, no chain calls, no infra
touched. NAT traversal and actually raising `wg` are out of scope here.

## Run
```bash
cd ..                      # poc/ (has node_modules: ethers, @noble/*)
node up-wg-handshake/handshake.mjs            # crypto layer, isolated
./up-wg-handshake/verify-wg-interop.sh        # derived key == real `wg` key
node up-wg-handshake/mainnet-integration.mjs  # wire onto live LUKSO mainnet board + simulate
```

## What each proves

`handshake.mjs` — full A↔B handshake:
- **Derivation (not conversion):** `WG_priv = clamp(HKDF-SHA256(ikm=UP_priv, salt=nonce, info="wg-x25519-v1"|path))`. secp256k1 private key as seed → X25519 WG key. You cannot convert the *curve*; you derive a separate key from the private *seed*. Deterministic → wallet regenerates WG key with zero stored state.
- **Authenticity (anti-MITM):** offer signed EIP-191 by the UP key; verifier **recomputes the digest from received fields** (never trusts a sent digest) and recovers the signer.
- **Confidentiality:** endpoint (the only must-not-leak field) ECIES-encrypted to the recipient UP's secp256k1 pubkey. Everything else (wgPub, path, nonce) is public and safe on-chain.
- **Adversarial checks all REJECTED:** tampered wgPub, forged from-address, wrong-recipient decrypt, expired offer.

`verify-wg-interop.sh` — feeds the derived private key to the real `wg` binary and confirms `wg pubkey` equals our computed X25519 pubkey. **MATCH** ⇒ the derived material is a valid WireGuard keypair with no translation.

## Mainnet integration (`mainnet-integration.mjs`) — DONE + simulated

Wires the handshake onto the **live LUKSO mainnet** path already in `poc/lukso-mainnet`:
- Target: `MessageBoard @ 0x64cB5aa841aB05A8fe586baf22924468259C493F` on chainId **42** — live-verified (1589 B code, `count()=1`, gas ~0.69 Gwei, 2026-10-21).
- **Size constraint caught by self-simulation:** the board caps bodies at **200 B**. A naive JSON/base64 offer was **206 B — over budget**. Fixed by (a) a compact binary `core = wgPub(32)||nonce(12)||expiry(5)||endpoint`, (b) `core||sig(65)` sealed as **raw-bytes AES-256-GCM** (not the shared `e2ee.encrypt`, which forces utf8+base64 and inflates binary). Result: **162 B ✓ fits**.
- One post carries both properties: **confidentiality** (conversation-key AES-GCM envelope) + **authenticity** (EIP-191 UP signature *inside* the envelope). `board.post(to, body)` is the "follow"/lobby signal.
- Simulated end-to-end with **no tx broadcast** (no key spend): build → post-bytes → unseal → verify signature → derive both WG keys. Adversarial: flipped-ciphertext, wrong-recipient, wrong-claimed-sender all **rejected**. Set `BROADCAST=1` + a funded signer to actually send (spends real LYX) — left as the deliberate manual final step.

## How it maps on-chain (remaining, not in this PoC)
- The same body rides in **LSP8 token metadata** — sending the token = the "follow"/lobby-entry signal, caught by the recipient's **Universal Receiver Delegate** (URD), which enforces the 3 access modes (private / follow-gated / open).
- Recipient conversation pubkey is exchanged/recoverable from the first on-chain signed tx (every LSP8 transfer is signed).
- LSP6 KeyManager exposes the controller map; user/mobile app picks the "encryption controller".
- Still open: **NAT traversal** (needs public IP or light STUN), defensive gas-bounded URD, replay/TTL enforcement on-chain.

See workspace memory `up-wireguard-lobby` for the full design + trade-offs.
