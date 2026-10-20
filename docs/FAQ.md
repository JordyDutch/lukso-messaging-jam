# FAQ.md — direct answers to B's original questions

_Grounded in `../research-lukso.md`, `../research-jam.md`, and this repo's PoC._

## Q1. Can LUKSO be used as a parachain for JAM?

**No. [verified]**

- LUKSO is an **EVM Layer-1** — unmodified Ethereum, PoS (beacon + execution clients),
  with its own chain id (42). It is **not** a Substrate/Polkadot parachain and has no
  relay-chain relationship.
- **JAM is replacing the Polkadot relay chain.** It does not "accept" external EVM L1s
  as parachains. The parachain model itself is being migrated *onto* JAM as services —
  that's a Polkadot-internal transition, not an onboarding path for LUKSO.
- So "LUKSO as a JAM parachain" is a category error. The realistic ways LUKSO and JAM
  can interact:
  - **(now) a relayer** between LUKSO events and a JAM service — the pragmatic path;
  - **(≈2027) a trust-minimized bridge** — Snowbridge generalized messaging or a
    light-client bridge (both planned/speculative, not production for arbitrary messages);
  - **(speculative) LUKSO's EVM as a JAM service** (EVM-in-PVM) — conceivable (JamZig ran
    Solana's VM in JAM) but **no proposal exists**.

## Q2. Can the JAM devnet "messaging system" be used in a nightly build of the UP app to chat between UP profiles?

**Not directly. [verified]**

- The **JAM testnet (Toaster / Tart)** is a **compute platform**, not a chat system.
  Developers submit **work packages** to cores over **JSON-RPC**; services expose only
  **`refine`** and **`accumulate`**. There is **no `on_message` primitive** and **no
  user-facing DM/chat** on JAM.
- **"Offchain Messaging"** (Parity, announced 2026-09-10) is **service-to-service**
  messaging to reduce relay-chain dependence — it is **in development**, not a shipped
  user chat API.
- So you cannot "turn on JAM devnet messaging" inside the UP app to get UP↔UP chat.
  What you *can* do now: build chat on **LUKSO** (anchor + IPFS + ERC-1271 + LSP25
  gasless) and treat JAM as an **optional, swappable availability/compute layer behind a
  relayer** (Phase 2+). That is exactly what this repo's PoC demonstrates end-to-end.

## Q3. So what does Fabian actually need to build?

**For a shippable nightly (Phase 1, no JAM):**
1. Deploy a reviewed **MessageAnchor** contract to LUKSO testnet (4201), then mainnet
   (reference: `poc/evm-side/contracts/MessageAnchor.sol`).
2. Ship the **chat UI as a Grid mini-app** via `@lukso/up-provider`
   (prototype: `poc/up-minapp/index.html`).
3. Put **bodies on IPFS**; anchor only `contentHash` + metadata; sign with the UP
   controller (ERC-1271 / LSP6 SIGN); make writes **gasless via LSP25**.
4. Add **LSP1 UniversalReceiver** inbox notifications (the one piece wanting app-core
   support). Expose the same inbox to **agents** via the official UP skill (agent = LSP6
   controller). See `docs/UP-APP-PROPOSAL.md`.

**For JAM later (Phase 2):** replace the mock JAM service with a real service on a JAM
DUNA/Toaster testnet and have the relayer `SubmitBundleToCore`. See `docs/RUN-JAM.md`.

## What this is NOT

- ❌ **No `on_message` primitive on JAM.** Message handling is app logic over
  `refine`/`accumulate`. The original premise assuming an `on_message` hook was wrong.
- ❌ **No hosted "JAM devnet-as-a-service".** `polkadot.cloud` could not be confirmed to
  host JAM devnets; you run your own (e.g. `jam-duna/coreplay`, a local 6-validator net).
- ❌ **No user chat dapp on JAM today.** All JAM demos are compute/protocol PoCs
  (FIB, Doom/CoreVM, Solana-VM-in-JAM).
- ❌ **No messaging LSP standard.** Thread model, ordering, read receipts, E2E encryption
  are all net-new on LUKSO too.
- ❌ **Not trust-minimized yet at the JAM boundary.** Today's path is a trusted relayer;
  trust-minimized bridging (Snowbridge generalized / light client) is ≈2027.
