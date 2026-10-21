# Frontend plan — UP-gated ephemeral WireGuard lobby

Status: **backend proven fully E2E on mainnet** (see README). This is the UI
proposal. **No code written yet — awaiting B's build decision.**

## What the user actually does (happy path)
1. Open the app, **connect Universal Profile** (UP browser extension).
2. First time only: **Announce** — publish your X25519 conversation pubkey on-chain (one tx, or gasless via LSP25 relay). One-time onboarding.
3. **Enter a lobby / invite a peer:** pick a UP (by `@name` via Envio, or paste address). App builds the signed+sealed WG offer and sends it as a lobby invite (registry `invite`, the token transfer = the "follow"/entry signal). Recipient's UP fires its Universal Receiver → the popup.
4. **Accept:** recipient sees the invite, decrypts the endpoint, app shows a "Connect" button.
5. **Connect:** app hands the derived WG config to a local agent and the tunnel comes up. Status dot goes green, shows handshake time + throughput. **Disconnect** tears it down and wipes the ephemeral key.

## The one hard constraint for the browser
A web page **cannot** raise a kernel WireGuard interface. The browser does
identity + chain + crypto; something local must own the tunnel. Three options
(decision needed):

| option | tunnel owner | UX | effort |
|---|---|---|---|
| **A. Local helper (recommended)** | a small local daemon / this OpenClaw agent exposes a localhost API; browser derives keys, POSTs the wg config, helper runs it in a rootless netns (exactly `wg-tunnel-test.sh`) | one-click after install | medium — reuse the lab script as the helper's core |
| B. WASM userspace WG (`wireguard-go`→wasm / `boringtun`) + in-page proxy | the page itself, via a userspace TUN over WebTransport/WS | no install, but only tunnels app traffic, not the OS | high — and doesn't give a real OS-level VPN |
| C. Config export | user | app just renders a `wg-quick` config + QR; user imports into their own WG client | low effort, manual, but honest and portable | low |

Recommendation: ship **C first (trivial, immediately useful, portable)**, then
**A** as the one-click experience built on the already-working lab helper. B
skips the WASM rabbit-hole (B) unless in-browser-only tunneling becomes a goal.

## Stack proposal
- **Framework:** Vite + React + TypeScript (matches LUKSO dApp norms).
- **UP connection:** `@lukso/up-provider` + `ethers v6` (already used here). No ENS.
- **Names:** Envio indexer GraphQL (`search_profiles_v2`) for `@name` → address.
- **Crypto in-browser:** `@noble/curves` + `@noble/hashes` (same libs as `lab-crypto.mjs` — the exact functions port 1:1 to the browser, WebCrypto for AES-GCM).
- **Chain:** RegistryV2 at `0xA5Be…2fcC` (or a fresh prod deploy); thirdweb RPC + fallback.
- **Gasless option:** LSP25 relay for `announce`/`invite` so users don't need LYX (watch the per-UP monthly quota).
- **Tunnel (option A):** reuse `wg-tunnel-test.sh` as the helper's core; localhost-only API, derives nothing itself (keys come from the page), bounded to the session.

## Screens (minimal)
1. **Connect UP** (empty state) → 2. **Announce** (one-time banner if not announced) → 3. **Lobby** (list of my invites in/out, read from registry events; "invite peer" input) → 4. **Session** (peer identity, decrypted endpoint, Connect/Disconnect, live handshake/throughput).

## Open questions for B (frontend only)
- Tunnel owner: **A (local helper)**, **C (config export)**, or both? (recommend both, C first)
- Gasless (LSP25 relay) for end users, or users pay their own gas?
- Deploy a **fresh production RegistryV2**, or reuse the lab one `0xA5Be…2fcC`?
- Where does it get hosted — standalone, or a tab inside the existing `:8443/vpn/` dashboard?

## What is NOT the frontend's job (belongs server/contract-side, still open)
- URD **mode enforcement** (private / follow-gated / open) — lives in each
  recipient's deployed Universal Receiver Delegate, not the UI.
- **NAT traversal** — real peers behind NAT need a public IP or light STUN; the
  lab uses loopback. This is the main remaining infra piece for real-world use.
- On-chain **replay/TTL** enforcement (offers carry expiry + nonce; contract
  could enforce).
