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
- Simulated end-to-end with **no tx broadcast** (no key spend): build → post-bytes → unseal → verify signature → derive both WG keys. Adversarial: flipped-ciphertext, wrong-recipient, wrong-claimed-sender all **rejected**.

## Real mainnet broadcast (`broadcast-mainnet.mjs`) — DONE, on-chain

Actually sent the signed WG-offer body to the live board (spends real LYX):
- Signer `0x80B8…0135` (its secp256k1 key both signs the EIP-191 offer and pays gas); recipient = blaise8 UP `0xa857…2D79`.
- **Board post id #1**, tx `0x1614f062abf347c235a279309d6f5b2f8645549c10ddcf644dcbbdabd563312a`, block 8618779, 162 B body, ~0.00019 LYX. `count()` went 1 → 2.
- `node up-wg-handshake/broadcast-mainnet.mjs` dry-runs (gas/size preview, no tx); `BROADCAST=1 …` sends.
- Confidentiality caveat: blaise8 hasn't announced an X25519 *conversation* pubkey yet, so the AES-GCM envelope is sender-reconstructable; recipient-side decrypt unlocks on their announce (the one-time onboarding step). **Authenticity (anti-MITM) is fully live regardless.**

## LSP8 lobby registry (`LobbyRegistry.sol` + `deploy-lobby.mjs`) — DONE, on-chain

The follow/lobby-entry half, as a minimal **LSP8-shaped** registry (not the full `lsp-smart-contracts` NFT): tokenId = lobby membership, per-token data = the sealed WG offer, `invite`=grant / `transfer`=hand-off / `revoke`=burn, and a **bounded-gas, swallow-revert LSP1 `universalReceiver` notification** (the "popup" trigger; anti-DoS so a hostile/absent URD can't brick mint/transfer).
- **Deployed** at `0xcCABa5e0Fc0aA7bdBae129B0b7A91A2f8Eb23B81` (tx `0x1bfed375…`), chainId 42.
- **Minted a real lobby invite to blaise8's UP** — tx `0x28acd462…`, block 8618789, tokenId `0x7d4cea17…`, body 162 B. On-chain `tokenOwnerOf(tokenId)` == blaise8 ✓.
- **blaise8's UP Universal Receiver accepted the notification** (`ReceiverNotified … ok`) — the lobby signal fired on a live UP, not a mock.
- Idempotent via `lobby-state.json` (public data only — addresses/tx/tokenId, no key). `BROADCAST=1 node up-wg-handshake/deploy-lobby.mjs`.

## Still open (not blocking the PoC)
- **Recipient conversation-pubkey announce** (LSP3 metadata or one signed tx) so counterparties can decrypt the endpoint, not just verify authenticity.
- **URD enforcement of the 3 access modes** (private / follow-gated / open) — the registry fires the notification; the mode logic belongs in the recipient's deployed URD.
- **NAT traversal** (public IP or light STUN), on-chain replay/TTL enforcement, LSP6 KeyManager controller-selection UI.

See workspace memory `up-wireguard-lobby` for the full design + trade-offs.
