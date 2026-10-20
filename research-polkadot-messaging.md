# Polkadot / JAM Person-to-Person Messaging — Devnet vs Production (Oct 2026)

_Research date: 2026-10-20. Companion to `research-jam.md`. Question: how can TWO PEOPLE actually DM each other in the Polkadot/JAM ecosystem (a) TODAY on devnet/testnet, (b) on PRODUCTION mainnet? Concrete user flow, what they sign, what they pay, latency, trust model._

_Note: web_search (DuckDuckGo) provider was STILL down this run (same as the prior pass). All findings rely on direct `web_fetch` of primary sources. Negative findings ("no such app found") are therefore "not found via primary-source fetch," not exhaustive proof of absence — but they are consistent across every primary source checked._

---

## TL;DR
1. **There is NO native, user-facing "send a DM" primitive anywhere in the Polkadot/JAM stack — not on devnet, not on mainnet.** Neither JAM services (`refine`/`accumulate` only) nor Polkadot's runtime expose a person-to-person messaging entry point. Confirmed again this pass. (parity.io; graypaper model)
2. **DEVNET TODAY (JAM Toaster/Tart): no two-user chat is possible as an app.** The only runnable artifact is the JAM DUNA bundle, whose sole demo is **FIB** (a compute stream), submitted as *work packages* over JSON-RPC by a developer — not a message between two human users. "Real services (smart contract/privacy)" are explicitly *future* testing, not shipped. (github.com/jam-duna/coreplay)
3. **The JAM community itself chats on Matrix** (`#jam:polkadot.io`, `#jam-conformance:matrix.org`) — i.e. the people building JAM use a Web2/off-chain messenger, not JAM, to talk. Strong signal that no on-JAM chat exists. (jam-duna README)
4. **PRODUCTION TODAY — the only real "two people write to each other on-chain" path on Polkadot mainnet is the `system.remark` / `remarkWithEvent` extrinsic.** You sign a transaction carrying arbitrary bytes in Polkadot-JS Apps (or any wallet), pay a tiny DOT fee, it lands in a block in ~6s (finalized ~12–18s). It is public, permanent, unencrypted. This is a *transaction with a memo*, not a chat app, but it genuinely lets two accounts write messages readable by each other (and everyone). [VERIFIED as a Substrate primitive; general knowledge]
5. **XCM is Cross-*Consensus* Messaging — chain-to-chain / service-to-service, NOT user-to-user.** It moves assets and call instructions between parachains/the relay chain. It is not a DM channel between two people. (confirmed design; prior research)
6. **The once-prominent Polkadot-ecosystem chat dapp (Grill.chat, built on Subsocial) appears DEFUNCT: `grill.chat` is now an expired domain listed for sale (~$100).** The flagship consumer "chat on Polkadot" product is gone. (expireddomains.com listing for grill.chat)
7. **"Offchain Messaging" (Parity's named Road-to-JAM workstream) is service/parachain messaging, re-confirmed verbatim:** Parity's own words — *"lets messages move directly between participants… able to support communication between services as the network transitions."* It is about moving *parachain* comms off the Relay Chain, NOT a consumer DM feature. In development; the forum deliverable bullets are STILL empty/unpublished. (parity.io/blog/jam-what-it-is-how-it-works; forum t/18621)
8. **Production JAM "message flow" for end users does not exist as a product and has no announced consumer app or SDK.** When JAM mainnet ships (staged hard fork, targeted 2026 but audit-gated/optimistic), a messaging *service* could be deployed, but a user would still interact by submitting work packages + buying Agile Coretime (paid in DOT) — there is no "JAM chat app" on any roadmap found.

---

## Verified facts (with sources)

### Devnet / testnet (JAM Toaster, Tart)
- **Only demo = FIB compute stream.** The current JAM DUNA release (GP 0.7.2, Linux AMD64, `v0.7.2.13-toaster`) brings up a 6-validator testnet and optionally runs a `fib-stream-runner` that logs `Work package SUBMITTED` / `SubmitBundleToCore CE146 SUCCESS`. The README states larger multi-client testnets are *expected to* "support further testing with real services (smart contract/privacy services)" — i.e. **not yet**. No chat/messaging demo exists in the bundle. Source: https://github.com/jam-duna/coreplay
- **How a "message" would even enter JAM today = a developer submits a work package via node JSON-RPC** (ports 19800–19805 in the bundle). There is no wallet, no user identity, no recipient addressing for human DMs. Source: same.
- **The JAM dev community coordinates on Matrix, not on JAM:** `#jam:polkadot.io` and `#jam-conformance:matrix.org`. Source: jam-duna/coreplay README.
- **W3F Implementer's Prize is a *node-implementation* competition, not an app competition.** Milestones are: (1) block/header serialization, (2) state serialization, (3) in-memory DB + Merklization, (4) non-PVM state transition, (5) PVM execution + host functions, (6) block-import tests. Judged by the Polkadot Fellowship. **There is no messaging/chat/app track and no messaging demo among the deliverables.** Prize pool 10M DOT + 100K KSM; ~5 language sets. Source: https://jam.web3.foundation/
- JAM testnet envs **Toaster** (multi-node perf) and **Tart**; conformance at https://paritytech.github.io/jam-conformance-dashboard/ . (prior research, unchanged)

### Production (Polkadot mainnet) — what exists for two people to "write to each other" NOW
- **`system.remark` / `system.remarkWithEvent` extrinsic** — the Substrate System pallet lets any account submit a transaction carrying an arbitrary byte blob. `remarkWithEvent` emits an event (with a hash of the data) so a counterparty can index/notice it. This is the de-facto "write a message on-chain" mechanism on Polkadot/Kusama and most Substrate chains. [VERIFIED primitive; core Substrate `frame-system`]
  - **User flow:** open Polkadot-JS Apps → Developer → Extrinsics → `system.remarkWithEvent(bytes)` → sign with your wallet (Polkadot-JS extension, Talisman, Nova, Ledger) → submit.
  - **What you sign:** a normal signed extrinsic (your transaction, nonce, tip).
  - **What you pay:** a standard DOT transaction fee (length-proportional; a short remark is a tiny fraction of a DOT). No Coretime involved — this is relay-chain/parachain runtime, not JAM.
  - **Latency:** included in the next block (~6s), finalized by GRANDPA in ~12–18s.
  - **Trust model:** fully public, permanent, unencrypted. Both parties (and the whole world + indexers) can read it. For privacy you must encrypt the payload client-side yourself (the chain gives no confidentiality, no delivery/read guarantees, no inbox UI).
- **XCM = Cross-Consensus Messaging:** moves tokens and encoded call instructions between consensus systems (parachains ⇄ relay ⇄ bridge hubs). It is **chain-to-chain**, not a human DM. There is no "send XCM to a person" — the destination is a chain/location, and the payload is instructions, not chat. (design; prior research confirms)
- **Snowbridge (Polkadot↔Ethereum):** production for **token transfers only**; generalized/arbitrary messaging "expanding," not production; ~30–60 min latency. (prior research, unchanged)
- **Consumer chat dapp status:** the most prominent attempt, **Grill.chat (Subsocial-based anonymous chat)**, is effectively dead — **`grill.chat` resolves to an expired-domain sale page** as of this fetch. Source: https://expireddomains.com/domain/grill.chat . (Subsocial's own site `subsocial.network` returned a TLS handshake error this pass — status unconfirmed, flagged as a gap.)

### Offchain Messaging (the named workstream) — re-confirmed scope
- Parity, verbatim: _"The first area is Offchain Messaging, the messaging protocol being developed for JAM. Rather than routing parachain communication through the Relay Chain, Offchain Messaging lets messages move directly between participants while preserving the guarantees the wider system needs… able to support communication between services as the network transitions."_ Source: https://www.parity.io/blog/jam-what-it-is-how-it-works
- This is one of four Road-to-JAM projects (PolkaJAM, Minimal Relay/AHM v2, **Offchain Messaging**, Parachain Service), announced 2026-09-10. The forum thread's per-project deliverable bullets are **still empty/unpublished** in the fetched content — no spec, no API, no demo linked. Source: https://forum.polkadot.network/t/the-road-to-jam/18621
- Forum confirms the "anyone can commit to JAM" point (relevant to who runs a messaging service): bkchr — _"A collator/workpackage producer can be basically anyone… if you don't have that much traffic… you can probably run completely without any consensus for committing to JAM."_ olanod is prototyping private zk-rollup org backends whose service code is _"mostly the proofs verification, processing messages"_ — B2B/org, not consumer chat. Source: forum t/18621 posts #6, #7.

### JAM execution/payment model (for the production flow)
- Services expose only `refine` (in-core, 341 cores, parallel) + `accumulate` (on-chain shared state). No `on_message`. Code runs on **PVM** (RISC-V). Source: https://www.parity.io/blog/jam-what-it-is-how-it-works
- **Coretime** (built on Polkadot's **Agile Coretime**) = metered access to core compute; work packages require Coretime; an authorizer system gates which workloads consume it. Coretime is bought/sold on the relay chain's coretime market (paid in DOT). Source: same.
- Transition to JAM mainnet is a **staged program culminating in a hard fork**, gated on audits/testing/ecosystem readiness. Source: same + forum. (Targeted 2026 but explicitly conditional → optimistic.)

---

## Planned / speculative (clearly marked)
- **A production user-messaging app on JAM** — none announced. No "JAM app," no consumer SDK, no wallet DM flow found on any primary source. [NOT FOUND / does not exist today]
- **Offchain Messaging as a usable messaging layer** — in development, service-to-service, no public spec/API/demo yet. [PLANNED]
- **Parachain Service finality on JAM** — current public impl is a PoC; needs integration, testing, audits. [PLANNED]
- **JAM mainnet hard-fork switchover** — staged, 2026 target but conditional. [PLANNED / optimistic]
- **Private zk-rollup "org backend" services on JAM that process messages** (olanod) — a prototype for B2B/orgs, explicitly not consumer DM. [SPECULATIVE / prototype]
- **Encrypted, inbox-style P2P chat built on `system.remark` or a messaging pallet** — technically buildable today on a Substrate chain, but no live production product found (Grill.chat/Subsocial appears defunct). [BUILDABLE, not a shipped product]

---

## Comparison with prior research (`research-jam.md`)

| Prior established finding | This pass | Verdict |
|---|---|---|
| JAM has no `on_message`; only `refine`/`accumulate`; messaging is app logic | Re-confirmed from Parity blog (service entry points, PVM) | **CONFIRMS** |
| JAM testnet live (Toaster/Tart); clients are nodes, not apps; work packages via JSON-RPC | Re-confirmed; jam-duna bundle = FIB over JSON-RPC 19800+; W3F prize milestones are all node-implementation, no app track | **CONFIRMS + EXTENDS** (W3F prize explicitly has no messaging/app track) |
| "Offchain Messaging" = service-to-service, not user chat; in development | Re-confirmed *verbatim* from Parity ("messages move directly between participants… between services"); forum deliverable bullets still empty | **CONFIRMS** (now with exact quote) |
| No end-user messaging/DM/chat dapp on JAM found | Re-confirmed; additionally the JAM community uses Matrix to chat | **CONFIRMS + EXTENDS** |
| Snowbridge = token transfers only, ~30–60 min | Unchanged (not re-fetched this pass) | **CONFIRMS (carried over)** |
| JAM mainnet = staged hard fork, 2026 optimistic | Re-confirmed from Parity blog (staged, culminates in hard fork, audit-gated) | **CONFIRMS** |
| (new) Production person-to-person on-chain write path | `system.remark`/`remarkWithEvent` is the real TODAY answer on Polkadot mainnet; XCM is chain-to-chain not user DM | **EXTENDS** (prior research didn't name the remark path or explicitly rule XCM as non-DM) |
| (new) Consumer Polkadot chat dapp | Grill.chat domain is expired/for-sale → the flagship consumer chat dapp is defunct | **EXTENDS** (new negative finding) |

**Net:** everything in the prior JAM research holds. Two new deltas: (1) the honest "today, on production" answer is the `system.remark` memo path, not any chat product; (2) the one notable consumer chat dapp in the ecosystem has died.

---

## How two people message each other — concrete flows

### A) DEVNET / TESTNET TODAY (JAM Toaster/Tart) — **no real user-to-user chat**
There is no two-human DM flow. The closest a developer can do:
1. Download `jamduna-release-linux-amd64.zip` (GP 0.7.2), `make gen-keys` / `gen-spec` / `run-validators` → a 6-validator local JAM testnet.
2. `make run-fib-stream` → a builder submits **work packages** to a core via JSON-RPC (ports 19800–19805); logs show `Work package SUBMITTED`.
3. That's a compute stream (Fibonacci), not a message addressed from Alice to Bob. There is **no wallet, no recipient address, no mailbox, no second user**. To fake "messaging," a developer would have to *write their own JAM service* (refine/accumulate) that interprets work-package payloads as messages and store/relay them — nothing ships that. **Status: not available as a user feature.**

### B) PRODUCTION TODAY (Polkadot mainnet) — **the only genuine on-chain write path**
Using `system.remarkWithEvent` (a transaction memo, not a chat app):
1. Alice opens Polkadot-JS Apps (or Talisman/Nova wallet) connected to Polkadot.
2. Developer → Extrinsics → `system.remarkWithEvent("hello bob <ciphertext>")`.
3. Alice **signs** a normal signed extrinsic with her account key.
4. She **pays** a small DOT transaction fee (length-based; fractions of a DOT). No Coretime.
5. Block in **~6s**, finalized **~12–18s**. Bob (running an indexer/subscription on Alice's address or the emitted event) reads the bytes.
6. **Trust model:** public, permanent, unencrypted on-chain; no delivery/read receipts; confidentiality only if Alice encrypts the payload client-side. This is "two accounts writing to each other on-chain," not a polished DM UX.
   - (XCM, Snowbridge: **not applicable** — chain-to-chain / token transfers, not person-to-person.)
   - (A dedicated chat dapp like Grill.chat: **not available** — defunct.)

### C) PRODUCTION once JAM mainnet ships — **not available today; shape if it existed**
No consumer messaging product is on the roadmap. The *mechanical* shape would be:
1. Someone deploys a **messaging JAM service** (code with `refine`/`accumulate`) — "can be basically anyone" per Parity (bkchr).
2. A user/app **buys Agile Coretime** (paid in **DOT** on the relay-chain coretime market) or uses a service that bundles it.
3. The user (or a relayer/collator on their behalf) submits a **work package** containing the message payload to a core via node JSON-RPC; `refine` processes it in-core, `accumulate` commits the result to shared state. **What's signed:** today that's a node/RPC submission, not a clean wallet "sign a DM" action — no consumer wallet flow is defined.
4. Delivery would depend on the service design + "Offchain Messaging" (still unspecified). **Latency/fees/UX: undefined — no product, no SDK, no app.** Mark every step "NOT AVAILABLE TODAY."

---

## Gaps / open questions
1. **web_search still down** → could not run broad queries ("polkadot messenger dapp", "substrate messaging pallet"). Negative findings are primary-source-consistent but not exhaustive.
2. **Subsocial live status** — `subsocial.network` threw a TLS error; only confirmed that its flagship app domain `grill.chat` is expired/for-sale. Whether any Subsocial chain/app still runs is unconfirmed.
3. **Offchain Messaging spec/API** — still no public spec; forum deliverable bullets empty. Monitor forum t/18621 + Parity blog.
4. **KILT identity messaging** — not fetched this pass; KILT does DID/credential exchange, not general chat; worth a dedicated check if identity-based messaging matters to the LUKSO design.
5. **Exact `system.remark` fee/size limits on current Polkadot** — not fetched live; stated figures are from the Substrate primitive's known behavior, not a live chain query.
6. **Any JAM messaging PoC from W3F prize teams** — none found in the prize structure (node-only milestones); a per-team audit could still surface a hobby demo, but none is indicated.

---

### Bottom line for the LUKSO×JAM design
Nothing changed the prior recommendation: **there is no user DM primitive to lean on — build a relayer + anchor-contract design and treat JAM messaging as service-to-service infrastructure, not a chat feature.** On production Polkadot, the only honest "two people write to each other on-chain right now" answer is a signed `system.remark` memo (public, DOT-fee, ~6–18s), with client-side encryption if privacy is needed.

---

## ⚠️ CORRECTION (2026-10-20, evening) — live user messaging DOES exist on the devnet

_A user (B) was using the **Polkadot Product Devnet app** (mobile + desktop, PCF/Parity) and reported: real DM chat between users with autocomplete user search, plus a **CASH** testnet token top-up from a faucet, with the app-level rule "you cannot send CASH until you start a conversation." This directly refines the earlier "no user messaging" conclusion. Sources: Polkadot Community Foundation forum posts (primary, fetched 2026-10-20)._

### What the app is
- **Polkadot Product Devnet** = Polkadot's official **pre-production** consumer network + app (X @Polkadot: "The Polkadot Devnet is our pre-production network, open to…"; polkadot.com tagline: "We're building the social layer for this different kind of internet. How you prove you're real without revealing who you are…").
- Apps: Android (Firebase App Distribution / APK), iOS (TestFlight), desktop (github.com/Polkadot-Community-Foundation/polkadot-desktop-community). Community: matrix `#polkadot-products-public:matrix.org`.
- It is a **product on the current Substrate/Polkadot stack** (Bulletin chain, CDM contract registry, Asset Hub, People) — **not** a JAM service. JAM is the separate, later transition.
- Real traffic: Chainspect reported Polkadot activity +150% linked to Product Devnet traffic (~4,960 tx in one hour, Sept 2026). The building team reportedly passed W3F **M1 interviews** (Oct 2026, via PolkadotDevs).

### How the messaging works (from PCF forum, verified)
- **Architecture = "host + primitives"** (dev feedback, forum t/18244): the app wraps everything so users don't touch deployment; the docs describe **primitives: `cash`, `messaging`, `identity`**. This is exactly the "messaging is app logic layered on chain primitives" model — consistent with research-jam.md, now with a shipped example.
- **Identity**: cryptographic "personhood pseudonyms" (pseudonym has a cryptographic context; updated in the Sept 2026 release). User discovery = the app's directory: typing a prefix (a, b, …) suggests matching users → **that is the autocomplete B saw** (client-side search over the registered pseudonym/.dot directory, e.g. DotNS `.dot` names).
- **Chat**: end-to-end style encryption with **X25519 key exchange** (upgraded from P-256 in the Sept 9 2026 release), chat search, multimedia, reply-to-transfer inside chat.
- **Data layer**: **Bulletin chain** stores app data (ephemeral posts, content; CIDs in contracts as pointers); apps have **storage allowances** (PGAS) — running out blocks you.
- **CASH / "coinage"**: a devnet test token, top-up via faucet ("Coinage management improvements (durability layer)" in the Sept 2026 release notes).
- **Why "can't send CASH until you start a conversation"**: transfers are **only allowed inside an existing conversation thread** ("Reply to a transfer inside chat" is an explicit feature). On-chain it's just a normal token transfer — the conversation requirement is an **app-level UX rule** (transfer attached to a chat thread/contact), not a protocol constraint. Flow: search user (autocomplete) → open chat → send a message (conversation exists) → send CASH inside that chat.
- **Caveat**: "It's a testnet; expect chaos!" — the Sept 2026 update required new usernames and **wiped contacts/messages** for all users.

### Comparison with prior findings — updated
| Prior finding | Now | Verdict |
|---|---|---|
| "No end-user messaging/DM/chat dapp on JAM/devnet found" | True for **JAM** (no JAM-based chat app; community still on Matrix) — but **FALSE for Polkadot devnet generally**: the official Product Devnet app ships working user DMs + payments today | **CONTRADICTS (extended)** — the negative finding was search-limited (provider down) |
| "Production today: only `system.remark` memo" | Still true for **mainnet** — Product Devnet is pre-production, not on Polkadot mainnet | CONFIRMS (scope clarified) |
| "Offchain Messaging = service-to-service" | Unchanged; the Product Devnet chat is a PCF app product on Substrate, independent of the Offchain Messaging workstream | CONFIRMS (now with a named counter-example that is NOT JAM-based) |
| "Grill.chat defunct" | Unchanged; the live consumer chat is now the **Product Devnet app** | EXTENDS |

### Bottom line (updated)
- **Devnet, today:** two people CAN DM each other — via the official Polkadot Product Devnet app (X25519-encrypted chat, pseudonyms, user autocomplete, CASH faucet token, transfers tied to conversations).
- **Production (mainnet), today:** still no user messaging product; `system.remark` remains the only honest on-chain write path. The Product Devnet is the strongest signal that a consumer messaging product is coming to mainnet (M1 passed, 150% activity spike), but it is not on mainnet yet.
- **For the LUKSO×JAM design:** this is the best available **reference architecture** for what "decentralized user messaging" looks like in practice (identity primitive + E2EE messaging primitive + cash primitive + directory search + storage layer), built as an app over chain primitives rather than as a protocol primitive. It validates the relayer+anchor-contract approach and shows the UX bar (autocomplete, encrypted DMs, in-chat payments).
