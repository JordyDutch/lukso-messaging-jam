# LUKSO × JAM — Decentralized messaging for Universal Profiles

**Pickup doc for Fabian (frozeman).** This repo is a handoff: research + an integration
design + a **working PoC** for adding DMs between Universal Profiles, with Polkadot JAM
as an *optional* backbone. Read this page, then `docs/FAQ.md` (your two questions,
answered), then `docs/DESIGN.md`.

_Date: 2026-10-20. Honesty policy: everything here is marked **verified** (from the two
research reports or the runnable PoC) or **stub/planned**._

## The 3 most important findings (incl. premise corrections)

1. **LUKSO cannot be a JAM parachain.** LUKSO is an EVM L1; JAM is *replacing* the
   Polkadot relay chain and does not onboard EVM chains as parachains. Coupling is via a
   **relayer** (now) or a **trust-minimized bridge** (≈2027). **[verified]**
2. **JAM has no chat / no `on_message`.** A JAM service exposes only `refine` +
   `accumulate`; the testnet (Toaster/Tart) is a compute platform you submit *work
   packages* to over JSON-RPC. "Offchain Messaging" (Parity, Sept 2026) is
   service-to-service and in development — **not** a user DM system. **[verified]**
3. **You can ship UP↔UP chat on LUKSO *now*, no JAM needed.** All primitives exist:
   on-chain metadata **anchor** + **IPFS** bodies + **ERC-1271/LSP6** auth + **LSP25**
   gasless + **LSP1** notifications. JAM becomes an optional, swappable layer later.
   **[verified: PoC runs end-to-end]**

## Recommended architecture (in ~10 lines)

- **Hybrid, 3 layers.** LUKSO is the **source of truth** for identity + ordering; JAM is
  an **optional availability/compute backbone behind a relayer boundary** (swappable).
- **L1 (LUKSO):** `MessageAnchor` contract stores only `{from,to,contentHash,ts,nonce}`
  keyed by `(threadId,recipient)`; bodies go to IPFS (hash on-chain). Per-sender nonce =
  replay protection + total order. Writes gasless via LSP25.
- **L2 (relayer):** watches `MessageAnchored`, emits a **work package** per message,
  forwards it. Phase 1: direct fan-out. Phase 2: a JAM service. Phase 3: trust-min bridge.
- **L3 (client):** chat UI as a **Grid mini-app** via `@lukso/up-provider`; agents use
  the official UP skill (agent = LSP6 controller) and share the same inbox.
- Auth: the UP controller signs each message (EIP-191); verified via ERC-1271 off-chain
  (relay + JAM `refine`) and optionally on-chain.

ASCII diagram + full detail: `docs/DESIGN.md §2`.

## What's in this repo (map)

```
README.md                      ← you are here (the pickup doc)
research-lukso.md              ← LUKSO/UP landscape, LSPs, official agent skill (input)
research-jam.md                ← JAM execution model, testnet, EVM interop (input)
docs/
  DESIGN.md                    ← full design: reqs, 3-layer arch, msg format, security,
                                 gas, options table, phased roadmap, risks, ASCII diagram
  FAQ.md                       ← B's 2 questions answered + "What this is NOT"
  RUN-JAM.md                   ← how to deploy the JAM service (verified-vs-not)
  UP-APP-PROPOSAL.md           ← feature request / PR outline for the UP app team
poc/
  evm-side/                    ← WORKS: MessageAnchor.sol + compile + end-to-end EVM demo
    contracts/MessageAnchor.sol
    compile.js  demo.js  demo-output.txt  build/MessageAnchor.json
  relay/                       ← WORKS: relayer + mock JAM service + full pipeline
    local-chain.js  relay.js  mock-jam-service.js  pipeline.js  pipeline-output.txt
  jam-service/                 ← STUB: Rust JAM service skeleton (refine/accumulate)
    src/lib.rs  Cargo.toml
  up-minapp/                   ← PROTOTYPE: standalone HTML+JS chat mini-app (up-provider)
    index.html
```

## Run the PoC (works today)

```bash
cd poc && npm install                 # ethers v6, solc, @ethereumjs/vm v10
cd evm-side && node compile.js && node demo.js      # L1 anchor + auth + replay demo
cd ../relay && node pipeline.js                      # EVM → relay → mock-JAM → inbox
# client prototype: open poc/up-minapp/index.html in a browser
```

## What to do next (concrete next 3 actions)

1. **Review `MessageAnchor.sol`** and decide the identity binding: keep `from = UP`
   (execute via LSP6 KeyManager) and whether to enforce the **on-chain ERC-1271 check**
   (the `_verifyUP` hook) or keep auth at the edges to save gas. Then deploy to **LUKSO
   testnet 4201**.
2. **Build the Phase-1 nightly**: wire `poc/up-minapp` to the deployed contract via
   `@lukso/up-provider`, put bodies on IPFS, and route writes through the **LSP25 relay**
   (gasless). Add **LSP1** inbox notifications. (No JAM.) See `docs/UP-APP-PROPOSAL.md`.
3. **Spike JAM Phase 2**: stand up a local `jam-duna/coreplay` testnet, port
   `poc/jam-service/src/lib.rs` to the real SDK, and swap the relay's mock call for
   `SubmitBundleToCore`. See `docs/RUN-JAM.md`.

## Status: verified vs stubbed

- **Verified (ran it):** contract compiles; deploys/executes on a real in-process EVM;
  EIP-191 signatures verified; replay reverts (`BadNonce`); inbox reads back; full
  relay→mock-JAM pipeline delivers to per-recipient inboxes. Proof: `poc/*/
  *-output.txt`.
- **Stub / not executed:** `poc/jam-service` (Rust skeleton — no public JAM SDK to
  compile against yet); `docs/RUN-JAM.md` steps (not run — no JAM node installed);
  on-chain ERC-1271 enforcement (documented hook, not wired); E2E encryption (design
  only); the mini-app's on-chain path (prototype uses localStorage as an anchor/inbox
  stand-in so it runs with no node).
- **The single decision for you:** *Is JAM in scope at all for v1, or is it a Phase-2
  option?* The design lets you ship Phase 1 on LUKSO alone and add JAM behind the
  relayer later without touching L1 or the client — see `docs/FAQ.md Q3`.
