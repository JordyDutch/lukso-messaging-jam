# Continuation Report for Fabian — UP × Polkadot Devnet messaging (v2)

Date: 2026-10-20 (evening). This is an **incremental addendum** to the original
handoff in this repo (see `README.md`). Everything it supersedes is marked below.
You can hand this doc to an LLM agent with this repo checked out — it is written
to be picked up cold.

## TL;DR

1. **Correction to the original research:** user-to-user messaging DOES exist on the
   Polkadot devnet *today* — in the official **Polkadot Product Devnet** app (PCF/Parity,
   pre-production). Working DMs: X25519-encrypted chat, user autocomplete over a
   pseudonym/`.dot` directory, and a **CASH** testnet token whose transfers are
   **gated to existing conversations**. It is **not** JAM — it's a PCF product on the
   current Substrate stack (Bulletin chain, CDM, Asset Hub, People).
2. **We built adapters that give a LUKSO Universal Profile the same flow.** New code:
   `poc/devnet-adapter/` (runs end-to-end: `node poc/devnet-adapter/devnet-spike.js`).
   One conversation is simultaneously stored in the devnet-style Bulletin store,
   encrypted E2E, and anchored on LUKSO via the existing `MessageAnchor` contract —
   all under the **same deterministic `threadId`** (verified: MATCH ✓ in the spike).
3. **The architecture decision is unchanged:** LUKSO anchor + swappable relayer + UP
   client. The devnet app is now our **reference implementation** for what shipped
   "decentralized user messaging" looks like — it validates the design and sets the
   UX bar.

## What changed since the original handoff (delta list)

| Original finding | New status |
|---|---|
| "No end-user DM/chat dapp found on JAM/devnet" | **Corrected for devnet** (Product Devnet app ships DMs now); **still true for JAM** (community chats on Matrix, `#jam:polkadot.io`) |
| "Production today: only `system.remark`" | **Unchanged** — Product Devnet is pre-production, not on mainnet |
| "Offchain Messaging = service-to-service workstream" | **Unchanged** — the Product Devnet chat is a PCF app product, independent of that workstream |
| "Grill.chat defunct" | **Superseded** — the live consumer chat is now the Product Devnet app |

Sources: PCF forum threads (t/18602, t/18244, t/18278) + live app observation (by B,
2026-10-20). Full report: `research-polkadot-messaging.md` (incl. the CORRECTION
section with all sources).

## The devnet flow, precisely (what we replicated)

1. User tops up **CASH** from a faucet.
2. Types a prefix in user search → **autocomplete** suggests registered users
   (prefix match over pseudonyms/`.dot` names).
3. Picks a user → conversation opens (thread registered).
4. Tries to send CASH **before** messaging → **rejected** ("can't send CASH until you
   start a conversation" — an **app-level UX rule**, not a protocol constraint).
5. Sends an E2E-encrypted message → conversation exists.
6. Sends CASH inside the chat → allowed (transfer attached to the thread).

Our spike reproduces all six steps on LUKSO with the same rules; output in
`poc/devnet-adapter/devnet-spike-output.txt`.

## Repo map (v2)

```
README.md                      ← original pickup doc (still accurate except the devnet finding)
research-lukso.md              ← (unchanged)
research-jam.md                ← (unchanged)
research-polkadot-messaging.md ← NEW: devnet-vs-prod messaging report + CORRECTION
docs/
  DESIGN.md, FAQ.md, RUN-JAM.md, UP-APP-PROPOSAL.md   ← (unchanged)
  ADAPTERS.md                ← NEW: the adapter mapping + the 5 tricks + how to
                                 attach to the real devnet + honest limits
poc/
  evm-side/  relay/  jam-service/  up-minapp/         ← (unchanged, all still pass)
  devnet-adapter/            ← NEW: identity.js (directory/autocomplete),
                                 e2ee.js (X25519 + AES-GCM), chat.js (Bulletin store,
                                 PGAS allowance, CASH gate), devnet-spike.js (E2E demo)
                                 devnet-spike-output.txt (run proof)
```

## Run everything (verified 2026-10-20)

```bash
cd poc && npm install
cd evm-side && node compile.js && node demo.js
cd ../relay && node pipeline.js
cd ../devnet-adapter && node devnet-spike.js
# client prototype: open poc/up-minapp/index.html in a browser
```

## What's in your hands (honest status)

**Verified (ran it):** contract on in-process EVM; EIP-191 auth; replay reverts;
relay→mock-JAM pipeline; **new:** E2EE (incl. outsider negative check), autocomplete
directory, conversation-gated CASH, cross-backend `threadId` match.

**Stub / not executed:** real JAM service (no SDK yet); ENS/DotNS resolvers (mock
directory); IPFS bodies (ciphertext kept in-memory); ERC-20 CASH (Map ledger);
forward secrecy (static keys); attachment to the **live** devnet (its API surface is
not publicly documented — see `docs/ADAPTERS.md` §"attach to the real devnet").

## Suggested next steps (ranked, each self-contained)

1. **Deploy `MessageAnchor` to LUKSO testnet 4201** and point the relay's
   `LocalChain` at a real RPC (the relayer is written only against `getLogs()` —
   drop-in). Then wire `up-minapp` via `@lukso/up-provider` with IPFS bodies +
   LSP25 gasless writes + LSP1 notifications. *(No JAM. This is shippable v1.)*
2. **Real resolvers:** replace `MockDirectory` with ENS (LUKSO) and/or DotNS `.dot`
   lookups; add an indexer for registration events so autocomplete stays fresh.
3. **Production E2EE:** swap `e2ee.js` static keys for X3DH/Double Ratchet (Signal).
4. **Live devnet probe (optional):** reverse-engineer the Product Devnet app's
   messaging requests (testnet, built for probing) and implement them behind the
   same adapter interface — then a client can talk to *either* backend.
5. **JAM Phase 2 (when SDK lands):** port `poc/jam-service/src/lib.rs` to the real
   SDK, swap the relay's mock for `SubmitBundleToCore` (see `docs/RUN-JAM.md`).
   Nothing in the client or L1 changes.

**The open decision (unchanged from v1):** is JAM in scope for v1, or Phase 2
behind the relayer? The devnet finding strengthens the "Phase 2" case: user
messaging clearly ships as **app logic over chain primitives**, which is exactly
what we can do on LUKSO today without waiting for JAM.

## Co-authors

Blazej Krzak (B) — direction, devnet app observation, repo; Z (agent) — research,
design, code.
