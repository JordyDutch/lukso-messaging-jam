# JAM (Join-Accumulate Machine) — Research for LUKSO Decentralized Messaging Integration

_Research date: 2026-10-20. Audience: integration design for adding decentralized messaging to LUKSO Universal Profile (an EVM L1). Goal: precise separation of what EXISTS today vs. what is PLANNED._

---

## TL;DR
1. **JAM is a decentralized computer, not a blockchain / not a messaging bus.** Services expose exactly **two** entry points: `refine` (in-core, parallel across ~341 cores) and `accumulate` (on-chain, shared state). **There is NO `on_message` entry point** — the original premise was wrong. Message handling is application logic layered on top of refine/accumulate, not a protocol primitive today. (parity.io)
2. **JAM testnet is live (since Jan 2026)** with ~45 independent client implementations across 5 "language sets"; testnet envs **Toaster** and **Tart**. Clients are *nodes that pass conformance fuzzing*, not apps. (graypaper.com/clients, jam.web3.foundation)
3. **"Offchain Messaging" is a real, NAMED Parity project — but it is in-development, not shipped.** It is part of the official 4-project "Road to JAM" (forum post, Sept 10 2026) and is about moving *parachain/service* messaging off the Relay Chain — it is NOT a user-facing chat/DM primitive. (forum.polkadot.network/t/the-road-to-jam/18621)
4. **How an app talks to a JAM service today: submit a "work package" to a core via the node's JSON-RPC.** Confirmed from the JAM DUNA testnet bundle (FIB demo: "Work package SUBMITTED", JSON-RPC ports 19800+). There is no mature public user-facing SDK/wallet flow yet. (github.com/jam-duna/coreplay)
5. **No end-user messaging/DM/chat dapp on JAM was found.** Demos are protocol/compute PoCs (FIB streams, Doom/CoreVM, Solana-VM-in-JAM). This is an important negative finding. (graypaper clients, jam-duna)
6. **Snowbridge (Polkadot↔Ethereum) is production for TOKEN TRANSFERS only**; generalized/arbitrary messaging is "expanding" but not the production path. Latency ~30–60 min each way. (polkadotecosystem.com)
7. **For LUKSO (EVM L1) to use JAM messaging today, the only feasible path is a trusted/semi-trusted relayer** bridging LUKSO on-chain events ↔ a JAM service work-package. Trust-minimized options (Snowbridge generalized messaging; a BEEFY/beacon light-client bridge; LUKSO-as-a-JAM-service) are 2027+ / speculative.
8. **Mainnet JAM via on-chain governance is targeted Q3–Q4 2026, culminating in a hard fork**, but the transition is explicitly staged and gated on audits/testing — treat "2026" as optimistic. (polkadot.academy, parity.io, forum)

---

## Verified facts (with sources)

### Execution model
- Two-stage computation: **refinement** (in-core, parallel; current architecture = **341 cores**) → work reports → **accumulation** (on-chain, against shared state). Flow: `Work → parallel refinement → work reports → accumulation → shared state`. Source: https://www.parity.io/blog/jam-what-it-is-how-it-works
- A **service** = code + storage + balance (like an Ethereum contract, broader model). **Entry points: `refine` and `accumulate` only.** Services can inspect other services' state and interact via the shared environment (synchronous-ish composability for the accumulate stage). Source: same + https://www.parity.io/blog/JAM-demystified-explainer
- Code runs on **PVM (Polkadot Virtual Machine)** — a RISC-V–based general-purpose VM (not an EVM-style blockchain VM). Source: same.
- **Coretime** = metered access to core compute (built on Agile Coretime). Work packages require Coretime. Source: same.
- Security = **ELVES** ("cynical rollup"): a subset of validators execute/check per core; disputes escalate to the full validator set. Gives sharded execution + shared security. Sources: parity blog; ELVES paper https://eprint.iacr.org/2024/961
- **Client ⇄ node interface is JSON-RPC; apps submit work packages to a core.** Evidence: JAM DUNA release Makefile exposes JSON-RPC ports 19800–19805 and a FIB demo that logs `Work package SUBMITTED` / `SubmitBundleToCore CE146 SUCCESS`. Source: https://github.com/jam-duna/coreplay (redirect from jam-duna/jamtestnet)
- **Low-traffic services can commit to JAM without their own consensus** (a work-package producer / collator "can be basically anyone"); a service's code can be "mostly proofs verification + processing messages." Source: Parity devs (bkchr, olanod) in https://forum.polkadot.network/t/the-road-to-jam/18621

### Messaging specifics
- **Offchain Messaging** is officially one of four "Road to JAM" workstreams (alongside PolkaJAM, Minimal Relay/AHM v2, Parachain Service), posted by Parity on the Polkadot forum **2026-09-10**. Its stated purpose: reduce Relay-Chain dependence by moving parachain/service messaging to **direct participant-to-participant delivery**. Source: https://forum.polkadot.network/t/the-road-to-jam/18621 and https://www.parity.io/blog/jam-what-it-is-how-it-works
- JAM's composability model: instead of "send a message and wait," services in the shared environment inspect each other's state and interact against a common view **during accumulation**. Cross-core/parallel work is in refinement. Source: parity blog.
- **GAP (not verified verbatim):** The Gray Paper's exact wire format for inter-service messages, message queues/pools, deterministic ordering, and backpressure were NOT confirmed from a primary source in this pass (graypaper.com is a dense technical doc; the specific sections were not fetched). Treat message-format details as unconfirmed.

### Ecosystem / testnet
- JAM testnet live since **Jan 2026**; W3F **Implementer's Prize = 10M DOT + 100K KSM**; ~**45 client implementations** across **5 language sets** (A: JVM/Go; B: C/C++/Rust/Swift/Zig…; C: Python/JS/Haskell/Lisp…; D: Julia/Elixir/Scala/OCaml…; Z: esolangs). Judged by the Polkadot Fellowship. Sources: https://jam.web3.foundation/ , https://graypaper.com/clients/ , https://polkadot.academy/the-race-to-build-jam-polkadots-next-protocol/
  - _Correction to prior note:_ "15 languages / 43 teams" ≈ right order of magnitude; the authoritative count is ~45 clients across 5 language sets.
- Testnet environments: **Toaster** (large multi-node perf testnet) and **Tart**. Conformance tracked at https://paritytech.github.io/jam-conformance-dashboard/ . Source: polkadot.academy; graypaper.
- **JamZig** (Zig, info@jamzig.dev) ran Solana's VM inside JAM; building "Polana." Source: polkadot.academy.
- **Snowbridge**: trustless Polkadot↔Ethereum bridge on Bridge Hub; **BEEFY** light client on the ETH side, **Beacon** light client on the Polkadot side; native ETH since 2025; ETH→Polkadot ~30–35 min, Polkadot→ETH ~35–60 min; fee paid in source-chain token; **token transfers are the production use case**, generalized messaging "expanding." Source: https://polkadotecosystem.com/dapps/bridges/snowbridge/

### Developer tooling — can you deploy a JAM service on Toaster/Tart TODAY?
- **Yes, as a developer PoC — not as a polished product.** The JAM DUNA bundle lets you stand up a 6-validator local testnet (or multi-machine Toaster deployment) and submit real work packages/services via `jamduna run` + JSON-RPC. It ships sample genesis services (`fib.jam`, authorizers). Source: https://github.com/jam-duna/coreplay
- **New-JAMneration / JAM-Protocol** (Go) has **passed Milestone 1** and is continuously fuzz-validated against JAM Conformance — it's a conformant node, not a messaging framework. Source: https://github.com/New-JAMneration/JAM-Protocol
- **PolkaJAM** is Parity's own JAM node implementation (the production node for the Parachain Service transition); listed on graypaper clients (Rust, no public repo link). Source: parity blog; graypaper.com/clients.
- **polkadot.cloud** rendered as a JS app with no extractable JAM-devnet-as-a-service offering — **could NOT confirm** it provides hosted JAM devnets. Treat "Polkadot-as-a-Service for JAM" as unverified. Source: https://polkadot.cloud/ (dynamic page).
- `paritytech/polkajam` on GitHub → **404** (no public repo at that path).

---

## Planned / speculative (clearly marked)
- **Offchain Messaging as a usable service-to-service messaging layer** — in development, no shipped spec/API confirmed. [PLANNED]
- **Parachain Service on JAM** providing finality instead of the Relay Chain — current public implementation is a **proof of concept**; needs integration, ecosystem testing, security work, audits. [PLANNED]
- **Full JAM mainnet switchover** — staged, culminating in a **hard fork**, gated on readiness; targeted 2026 but explicitly conditional. [PLANNED]
- **Parity migrating parachain functionality to JAM services, ~2027** — consistent with the staged roadmap; the specific "2027" figure was a secondary source (coinfomania) and remains **secondary/approximate**.
- **EVM-execution-as-a-JAM-service** (i.e., running an EVM inside PVM as a JAM service) — architecturally plausible (JamZig did it for Solana's VM) but **no public LUKSO/EVM-in-JAM proposal found**. [SPECULATIVE]
- **ZK-rollup services verified by a JAM service** — being prototyped by a Parity dev (olanod) for private org backends; not a product. [SPECULATIVE]

---

## EVM ↔ JAM interop path for LUKSO (feasibility, trust, latency)
| Option | What it is | Feasible today? | Trust | Latency |
|---|---|---|---|---|
| (a) Snowbridge generalized messaging | Reuse Snowbridge's BEEFY/Beacon light-client bridge to carry arbitrary messages, not just tokens | **No** — only token transfers are production; generalized messaging still "expanding" | Trust-minimized (light clients) | ~30–60 min each way |
| (b) Relayer service (EVM events ↔ JAM work-package) | Off-chain relayer watches LUKSO `UniversalProfile`/LSP events, submits a JAM work package; and vice-versa | **Yes, buildable now** (this is the pragmatic path) | Trusted/semi-trusted relayer (or multisig/committee) | Seconds–minutes; you design it |
| (c) LUKSO as a JAM service (EVM-in-PVM) | Run LUKSO's EVM execution as a JAM service | **No** — speculative; no proposal exists; PVM is RISC-V, needs an EVM interpreter on PVM | Inherits JAM/ELVES security | n/a |
| (d) Light-client bridge (custom) | LUKSO beacon/consensus light client on JAM side + JAM proof on LUKSO side | **No (today)** — heavy build; depends on JAM mainnet + tooling | Trust-minimized | minutes |

**Recommendation for a near-term LUKSO messaging design:** build **(b) a relayer** between LUKSO events and a JAM service (or, honestly, between LUKSO and *any* availability/messaging layer), keeping the JAM service boundary clean so you can swap the trusted relayer for (a)/(d) once JAM mainnet + Offchain Messaging + generalized Snowbridge actually ship (≈2027). Do **not** design assuming a JAM `on_message` primitive or a hosted JAM devnet-as-a-service — neither exists.

---

## Gaps / open questions
1. **Gray Paper message format / queues / ordering / backpressure** — not verified verbatim. Need a direct pass over graypaper.com (or the PDF) sections on messaging & the accumulate stage before committing to a wire design.
2. **Offchain Messaging API surface** — no public spec/SDK found; the forum deliverable bullets were collapsed/empty in the fetched markdown. Monitor the forum thread + Parity blog.
3. **polkadot.cloud JAM offering** — unconfirmed whether it hosts JAM devnets/services (JS page not scrapable here).
4. **Snowbridge generalized-messaging timeline** — "expanding" is vague; need a dated roadmap.
5. **Any user-facing messaging dapp on JAM** — none found; worth a second search once the web-search provider is back (DuckDuckGo provider was down this run).
6. **LUKSO-specific interest in JAM** — no evidence LUKSO or its community is pursuing JAM; this integration would be greenfield.

---

## Key repos / links
- **graypaper.com/clients** — authoritative list of ~45 JAM client implementations. https://graypaper.com/clients/
- **jam.web3.foundation** — Implementer's Prize rules, language sets, milestones. https://jam.web3.foundation/
- **New-JAMneration/JAM-Protocol** — Go JAM node, M1 passed, fuzz-validated. https://github.com/New-JAMneration/JAM-Protocol
- **jam-duna/coreplay** (←jam-duna/jamtestnet) — downloadable JAM DUNA node binaries + local/Toaster testnet + FIB work-package demo; the most concrete "run a JAM testnet + submit a service" artifact. https://github.com/jam-duna/coreplay
- **PolkaJAM** — Parity's production JAM node (Rust; no public repo link on the clients list).
- **Gray Paper** (the JAM spec, Gavin Wood) — https://graypaper.com/ (and https://www.polkajam.com/)
- **Snowbridge** — Polkadot↔Ethereum bridge (token transfers prod). https://polkadotecosystem.com/dapps/bridges/snowbridge/
- **polkadot-sdk** (parachain/Substrate stack, context) — https://github.com/paritytech/polkadot-sdk
- **JAM Conformance Dashboard** — https://paritytech.github.io/jam-conformance-dashboard/
- **"The Road to JAM"** forum thread (official 4-project roadmap incl. Offchain Messaging) — https://forum.polkadot.network/t/the-road-to-jam/18621
- **Parity explainers** — https://www.parity.io/blog/jam-what-it-is-how-it-works , https://www.parity.io/blog/JAM-demystified-explainer

_Note: web_search (DuckDuckGo) provider was unavailable during this run; findings rely on direct fetches of primary sources (Parity, Web3 Foundation, graypaper, Polkadot forum, GitHub). Secondary-source items are flagged._
