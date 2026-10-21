# Plan — UP-gated P2P channel (text + voice + video) over WebRTC

Status: **backend layers 1–3 proven fully E2E on mainnet** (see README — the
WireGuard lab). Transport pivots from WireGuard to **WebRTC**. **No code written
yet — awaiting B's build decision.**

Decided with B (2026-10-21): the goal is a **private P2P channel between two
UPs — text + voice + video** — not a full-device VPN. WireGuard was the example
that proved the identity→key→E2E stack; WebRTC is the better transport (runs in
the browser, voice/video native, ICE/STUN built in). No self-hosted
infrastructure in the data path.

## The layering — WebRTC swaps only the transport
What we built had 4 layers. WebRTC replaces **only the bottom one**. Layers 1–3
(`lab-crypto.mjs`) carry over **unchanged**.

| layer | WireGuard lab (built) | WebRTC (going) | fate |
|---|---|---|---|
| **Identity** | UP + secp256k1 EIP-191 | same | **1:1** |
| **Signaling / rendezvous** | announce on-chain (RegistryV2) | same (SDP offer/answer + ICE candidates announced on-chain) | **1:1** |
| **Secret exchange** | sealed+signed offer, static-static X25519 ECDH conv-key | same | **1:1** |
| **Transport (moves bytes)** | kernel WireGuard (Noise) | WebRTC DataChannel + audio/video tracks (DTLS-SRTP) | **← only this changes** |

One WebRTC peer connection carries **all three**: DataChannel (text/files),
audio track (voice), video track (video) — same ICE, same hole-punch, same DTLS
encryption. This is how Meet/Discord/WhatsApp calls work underneath, except our
**signaling is on-chain (LUKSO), not a company server**.

## Derivation path — survives, just changes `info`
The derivation path was never about WireGuard. It's the rule: *from one UP key,
deterministically derive a fresh ephemeral per-session key, with zero stored
state.* WireGuard was only its consumer. WebRTC has the identical need and reuses
it 1:1:

- WebRTC's DTLS certificate (keypair + fingerprint in SDP) is random-by-default
  and thrown away → no identity binding, no determinism.
- Instead, derive the DTLS key from the UP controller priv:
  `DTLS_priv = HKDF-SHA256(ikm = UP_privkey, salt = nonce, info = "webrtc-dtls-v1" ‖ path)`.
  Gains, same as WG had:
  - **determinism** — UP regenerates the session key on demand, zero stored state.
  - **domain separation** — `info` goes from `wg-x25519-v1` → `webrtc-dtls-v1`,
    so the WebRTC key **never collides** with a WG key from the same seed
    (the hard no-cross-protocol-reuse rule holds).
  - **identity↔channel binding** — sign the DTLS fingerprint with the UP key
    (EIP-191) and announce it on-chain → cryptographic proof "this WebRTC
    channel belongs to UP 0x…". **This closes anti-MITM for voice/video**, which
    WebRTC does NOT give on its own.

So the derivation path becomes the thing that gives WebRTC determinism +
anti-MITM. The WG lab stays in-repo as the realized proof of layers 1–3 and as
the option for a future full-VPN mode.

## Happy path (what the user does)
1. **Connect Universal Profile** (UP browser extension — enough; no helper, no root).
2. First time only: **Announce** your X25519 conversation pubkey on-chain (one tx, or gasless via LSP25). One-time onboarding.
3. **Call / invite a peer:** pick a UP (`@name` via Envio, or paste address). App builds the signed+sealed WebRTC offer (SDP + derived DTLS fingerprint) and announces it on-chain (RegistryV2). Peer's UR fires → incoming-call UI.
4. **Answer:** peer reads the offer from chain, decrypts, verifies the EIP-191 sig + fingerprint binding, posts its answer + ICE candidates on-chain.
5. **Connect:** ICE/STUN hole-punches directly P2P → DataChannel + audio/video open. Text, voice, video over one encrypted (DTLS-SRTP) P2P link. Nothing transits our infra.

## NAT (no self-hosted rendezvous — decided with B)
- **Discovery:** public STUN only (e.g. `stun.l.google.com:19302` + others) to learn each side's external `ip:port`. STUN carries no traffic.
- **Rendezvous:** **LUKSO is the signaling server** — SDP + ICE candidates announced on-chain, not via any server we run.
- **Direct:** ICE hole-punch → pure P2P for the ~80% of NATs where it works.
- **Symmetric NAT (~20%):** needs TURN (relay = data in path = hosting we won't run). **For now: public/optional TURN + fallback "user provides reachability" (public IP / port-forward)**; a dedicated TURN is deferred (B: "ok na teraz"). Honest message to the user when their network can't punch. Hurts more on voice/video (call won't establish) — revisit later.

## Stack proposal
- **Framework:** Vite + React + TypeScript (LUKSO dApp norm).
- **UP connection:** `@lukso/up-provider` + `ethers v6` (already used). No ENS.
- **Names:** Envio indexer GraphQL (`search_profiles_v2`) for `@name` → address.
- **Crypto:** `@noble/curves` + `@noble/hashes` — `lab-crypto.mjs` functions port 1:1 to the browser (WebCrypto for AES-GCM). Add the `webrtc-dtls-v1` derivation branch.
- **Transport:** browser-native WebRTC (`RTCPeerConnection`, `RTCDataChannel`, `getUserMedia` for voice/video). Deterministic DTLS cert from the derived key (`RTCPeerConnection({certificates})`).
- **Chain:** RegistryV2 at `0xA5Be…2fcC` (or a fresh prod deploy); thirdweb RPC + fallback. Extend with SDP/ICE announce fields (bodies may exceed the 200 B WG cap — SDP is bigger; chunk or store a hash + off-chain blob if needed).
- **Gasless option:** LSP25 relay for announce/offer so users need no LYX (watch per-UP monthly quota).

## Screens (minimal)
1. **Connect UP** → 2. **Announce** (one-time banner) → 3. **Contacts/Lobby** (invites in/out from registry events; "call peer" input) → 4. **Call** (peer identity, verified fingerprint badge, text pane + mute/camera toggles, connection state, hang up — wipes ephemeral keys).

## Open questions for B (frontend only)
- **SDP on-chain:** SDP is larger than the 200 B WG body. Announce full SDP (chunked), or announce only a hash + fetch the blob off-chain (e.g. IPFS)? (leaning: hash on-chain + sealed blob off-chain, keeps chain cheap)
- Gasless (LSP25) for end users, or users pay their own gas?
- Deploy a **fresh production RegistryV2** (with SDP/ICE fields), or extend the lab one `0xA5Be…2fcC`?
- Hosting: standalone, or a tab inside the existing `:8443/vpn/` dashboard?

## What is NOT the frontend's job (server/contract-side, still open)
- URD **mode enforcement** (private / follow-gated / open) — lives in each recipient's deployed Universal Receiver Delegate.
- **Dedicated TURN** for symmetric NAT — deferred; public/optional + user-reachability fallback for now.
- On-chain **replay/TTL** enforcement (offers carry expiry + nonce; contract could enforce).

## Carried over, proven, unchanged (do not rebuild)
`lab-crypto.mjs` layers 1–3 (identity, announce, static-static X25519 ECDH
conv-key, seal/open, EIP-191 sig) + the derivation-path mechanism. The WireGuard
lab (`wg-tunnel-test.sh`, `e2e-loop.mjs`) stays as the realized PoC and the
future full-VPN option.
