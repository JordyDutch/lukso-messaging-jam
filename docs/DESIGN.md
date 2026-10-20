# DESIGN.md — Decentralized messaging for LUKSO Universal Profiles (with optional JAM)

_Author: integration architect. Date: 2026-10-20. Grounded in `../research-lukso.md`
and `../research-jam.md`. Every claim is marked **[verified]** (from those reports or
this repo's runnable PoC) or **[speculative]/[planned]** where it depends on things
that don't exist yet._

---

## 1. Requirements

- **DMs between UP profiles.** Identity = **UP address** (LSP0 ERC725Account), not ENS
  (LUKSO has no ENS — **[verified]**, research-lukso §TL;DR).
- **Verifiable / authentic.** A message provably comes from the sender UP: controller
  signature verifiable against the UP via **ERC-1271 / LSP6 SIGN** **[verified]**.
- **Private (optional).** E2E encryption as an option; bodies never on-chain in clear.
- **Decentralized storage.** Bodies off-chain on **IPFS/Arweave**, referenced by a
  content hash / LSP2 VerifiableURI **[verified: primitives exist]**.
- **Works in the UP app** (mobile/desktop/web). The app is closed BETA, so the
  integration vehicle is a **Grid mini-app via `@lukso/up-provider`** **[verified]**.
- **Cheap / gasless.** Per-message cost near zero; use **LSP25 relay** (gasless, LUKSO
  only) **[verified]**; keep bodies off-chain.

---

## 2. Architecture (RECOMMENDED: hybrid, 3 layers)

```
            ┌──────────────────────────── L3 CLIENT LAYER ────────────────────────────┐
            │  UP app (closed BETA) ── Grid mini-app via @lukso/up-provider  (chat UI) │
            │  AI agent path: openclaw-universalprofile-authorize skill (LSP6 ctrl)    │
            └───────────────┬───────────────────────────────────────▲──────────────────┘
          sign (EIP-191 /   │ anchor() + IPFS put                    │ read inbox
          LSP6 SIGN,ERC1271) │                                        │ (events / JAM state)
            ┌───────────────▼──────────── L1 LUKSO ON-CHAIN ─────────┴──────────────────┐
            │  MessageAnchor contract: (threadId,recipient) => [{from,to,contentHash,   │
            │  ts,nonce}]  event MessageAnchored(...)  per-sender nonce (replay guard)  │
            │  bodies OFF-CHAIN: IPFS/Arweave, pointer via LSP2 VerifiableURI           │
            │  gasless writes via LSP25 ExecuteRelayCall + LUKSO relayer (per-UP quota) │
            └───────────────┬───────────────────────────────────────▲──────────────────┘
          watch events      │  work package (DeliverMessage)         │ inbox query
            ┌───────────────▼──────── L2 RELAYER / AVAILABILITY ─────┴──────────────────┐
            │  Relayer: watches MessageAnchor, builds work packages, forwards them.     │
            │  ── THE JAM BOUNDARY (swappable) ──                                        │
            │  Phase 1: no JAM (direct fan-out / notifications).                         │
            │  Phase 2: submit to a JAM service (refine→accumulate; NO on_message).      │
            │  Phase 3: trust-minimized bridge (Snowbridge generalized / light client). │
            └────────────────────────────────────────────────────────────────────────────┘
```

Why these layers map cleanly: **LUKSO is the source of truth for identity + ordering**
(cheap, already has gasless + ERC-1271), and **JAM is an optional compute/availability
backbone behind a relayer boundary** you can swap without touching L1 or L3.

### Layer detail

- **L1 (LUKSO on-chain).** `MessageAnchor.sol` (this repo) anchors only metadata:
  `from, to, contentHash, timestamp, nonce`, keyed by `(threadId, recipient)`, emits
  `MessageAnchored`. Bodies live off-chain; `contentHash = keccak256(body)` ties them
  to the anchor. In production `from` is the UP; the anchor is executed through the
  UP's LSP6 KeyManager and (optionally) gated by an on-chain **ERC-1271** check
  (`_verifyUP` hook in the contract). **[verified: compiles + runs, see poc/]**
- **L2 (relayer / JAM boundary).** A relayer watches `MessageAnchored` and emits a
  **work package** per message. This is the only EVM↔JAM path feasible today — a
  **trusted/semi-trusted relayer** **[verified, research-jam Option (b)]**. It cannot
  forge: it forwards the controller signature and the JAM service re-verifies it.
- **L3 (client).** Grid mini-app (`@lukso/up-provider`) for humans; the official
  agent skill (agent = LSP6 controller) for agents. Both read the same inbox.

---

## 3. Message format (canonical work package / anchored record)

```jsonc
{
  "kind": "jam.work_package/deliver_message",
  "threadId":    "0x… (bytes32) = keccak256(sortedPair(upA, upB))",
  "from":        "0x… sender UP address",
  "to":          "0x… recipient UP address",
  "contentHash": "0x… (bytes32) keccak256 of the off-chain body (ciphertext)",
  "nonce":       0,                 // per-sender monotonic; total order + replay guard
  "digest":      "0x… keccak256(abi.encode(threadId,to,contentHash,nonce))",
  "sig":         "0x… EIP-191 signature by the UP controller (verifies via ERC-1271)"
}
```

- **On-chain** stores: `threadId, from, to, contentHash, timestamp, nonce` (not `sig`,
  to save gas). **Off-chain** (relay/IPFS) carries `sig` + the body.
- **Body** (off-chain JSON): `{ v, threadId, from, to, nonce, ts, body|ciphertext, enc? }`.

### Identity mapping (UP ↔ JAM service)

A small **registry** maps a UP address → its JAM service address/id (and vice-versa),
so a JAM service knows which inbox to write. In Phase 1 this is trivial (the relay keys
inboxes by UP address directly, as the PoC does). In Phase 2 it's a lookup table in the
JAM service state or a LUKSO registry contract. **[speculative beyond Phase 1]**

---

## 4. Security model

| Threat | Mitigation | Status |
|---|---|---|
| **Forgery** (send as someone else) | Message `digest` signed by the UP controller; verified via ERC-1271/LSP6 off-chain (relay + JAM refine) and optionally on-chain (`_verifyUP`) | **[verified in PoC]** off-chain; on-chain hook stubbed |
| **Replay / reorder** | Strict per-sender monotonic `nonce` on-chain (`BadNonce` revert); JAM service mirrors it `(from,nonce)` | **[verified in PoC]** — replay reverts, see demo-output.txt |
| **Relay censorship** (liveness) | Relay can withhold but not forge; mitigate with multiple relayers / committee; L1 anchor is still the source of truth | **[design]** |
| **Content confidentiality** | E2E encryption at the body layer; store ciphertext on IPFS; `contentHash` over ciphertext | **[speculative]** — LSP6 ENCRYPT/DECRYPT bits exist, no protocol defined |
| **Spam** | LSP1 receiver can filter; optional stake/allowlist via LSP6 AllowedCalls | **[design]** |

**E2E option.** Derive a per-pair symmetric key via X25519 ECDH between keys published
in each UP's LSP3/ERC725Y data, optionally a double-ratchet for forward secrecy. This is
**net-new** (no on-chain protocol today). **[speculative]**

---

## 5. Gas analysis

- LUKSO mainnet gas ≈ **1.35 Gwei** (live, 2026-10-20) — extremely cheap **[verified,
  research-lukso]**. Still, per-message `setData`/writes don't scale, so **only a
  metadata anchor** goes on-chain; bodies stay off-chain.
- **Gasless for users:** LSP25 ExecuteRelayCall + LUKSO relayer, **per-UP monthly LYX
  quota** (`up quota`, `UP_QUOTA_EXCEEDED`) **[verified]**. Messaging should ride this so
  users pay nothing.
- **Batching:** high-volume senders/relayers can batch N anchors into one tx (array of
  records) to amortize base cost; the `nonce` stays per-message. **[design]**
- Base/Ethereum UPs have **no gasless path** — messaging is **LUKSO-first** **[verified]**.

---

## 6. Options comparison

| Option | Identity source of truth | Availability/transport | Feasible today | Trust | Verdict |
|---|---|---|---|---|---|
| **JAM-only** | JAM service | JAM | **No** — no user chat on JAM, no `on_message`, no hosted devnet-as-service | JAM/ELVES | ✗ premise doesn't hold |
| **LUKSO-native only** | LUKSO (UP + anchor) | relayer / LSP1 fan-out | **Yes** | relayer liveness | ✓ ship Phase 1 now |
| **Hybrid (RECOMMENDED)** | **LUKSO** (identity + anchor + ordering) | **JAM optional**, behind a swappable relayer | **Yes** (JAM mocked now) | relayer now → trust-min later | ✓✓ |

**Why LUKSO can't be a JAM parachain** **[verified, research-jam]**: LUKSO is an **EVM
L1** (unmodified Ethereum, PoS), not a Substrate parachain. JAM is **replacing the
Polkadot relay chain**; it does not accept EVM chains as parachains. So "LUKSO as a JAM
parachain" is not a thing. The realistic couplings are a **relayer** (now) or a
**trust-minimized bridge** (Snowbridge generalized messaging / light client, ≈2027).
Running LUKSO's EVM *as a JAM service* (EVM-in-PVM) is architecturally conceivable
(JamZig ran Solana's VM in JAM) but **no proposal exists** — speculative.

---

## 7. Phased roadmap

- **Phase 0 — this repo's PoC (DONE).** MessageAnchor on a local EVM; EIP-191 auth;
  replay protection; relayer → mock JAM service (refine/accumulate) → inbox; mini-app
  prototype. **[verified: runs]**
- **Phase 1 — nightly build, LUKSO-only (shippable now by Fabian's team).** Deploy
  MessageAnchor to LUKSO testnet→mainnet; chat mini-app via up-provider; IPFS bodies;
  LSP1 inbox notifications; gasless via LSP25. **No JAM.** **[all primitives verified]**
- **Phase 2 — JAM devnet.** Replace the mock JAM service with a real service on a JAM
  **DUNA/Toaster** testnet; relayer does `SubmitBundleToCore` over JSON-RPC. **[planned;
  depends on JAM SDK maturity]**
- **Phase 3 — JAM mainnet + trust-minimized bridge (≈2027).** Swap the trusted relayer
  for Snowbridge generalized messaging or a light-client bridge; adopt Parity's
  "Offchain Messaging" if its API ships. **[planned/speculative]**

---

## 8. Risks & open questions (carried from both research reports)

1. **No conversation standard** in any LSP (thread model, ordering, read receipts, E2E) —
   all net-new; a LIP would be the right home. **[verified gap]**
2. **JAM is not a messaging bus**: only `refine`/`accumulate`, no `on_message`; no hosted
   JAM devnet-as-a-service; "Offchain Messaging" is service-to-service, in development.
3. **Gray Paper wire format / queues / ordering** for inter-service messages not verified
   verbatim — confirm before committing a JAM wire design.
4. **Relay quota** headroom at chat-rate traffic unknown (per-UP monthly LYX quota).
5. **IPFS pinning durability** (who pins?), Arweave cost; no LUKSO-native DA layer.
6. **E2E encryption** protocol undefined on-chain; LSP6 ENCRYPT/DECRYPT bits are flags only.
7. **Cross-chain**: UPs also exist on Base/Eth (no gasless relay there) — LUKSO-first.
8. **Snowbridge generalized-messaging timeline** vague ("expanding"), token-transfer-only
   in production today.
