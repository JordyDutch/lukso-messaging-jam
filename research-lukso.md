# LUKSO & Universal Profile — Research for Decentralized Messaging Integration

_Compiled: 2026-10-20. Scope: what exists TODAY vs. planned. Feeds a design for adding decentralized messaging to the UP app (mobile + desktop)._

> STATUS: complete.

## TL;DR
- LUKSO is an **L1 EVM chain** (unmodified Ethereum, PoS). **No official LUKSO L2/rollup exists**; cross-chain to Base/Ethereum is done by redeploying the same UP address via LSP23, and there are bridges (Hyperlane `lsp-bridge-HypLSP7`), not a rollup.
- **UP apps (browser extension + mobile) are BETA**; the main web UP app is **universaleverything.io** (Vue/Nuxt + GraphQL indexer). **None has any DM/chat feature today.**
- The **official AI-agent skill** = `lukso-network/openclaw-universalprofile-authorize` (name `universal-profile`, v0.9.0, author frozeman). An agent acts as a **controller EOA** authorized on a UP's **LSP6 KeyManager** with a permission bitmask; onboard at my.universalprofile.cloud + openclaw.universalprofile.cloud.
- **No messaging primitive exists in any LSP.** Closest social rails: **LSP26 FollowerSystem** (on-chain follow graph), **Forever Moments** (social NFTs, LUKSO-only), LSP28 TheGrid (profile widgets), and `@lukso/activity-sdk` feeds.
- **CORRECTION:** LSP14 = **Ownable2Step** (two-step ownership transfer, iface `0x94be5999`) — NOT "Remote Caching"/storage. No LSP provides decentralized message storage.
- A DM could be built from reusable pieces: **LSP2 ERC725Y custom keys → VerifiableURI → IPFS/Arweave** message log, **ERC-1271/LSP6 SIGN** for per-message auth against the UP, **LSP1 UniversalReceiver** as the inbox-notification hook. All of the conversation/thread/encryption logic is net-new.
- **Gasless messaging is viable on LUKSO only**: LSP25 ExecuteRelayCall + LUKSO relay (per-UP monthly quota). Base/Ethereum have no gasless path in the skill. ERC-4337 paymaster utils exist (`tools-lukso-permissionless.js`).
- **Live gas (LUKSO mainnet, 2026-10-20):** ~**1.35 Gwei** (`eth_gasPrice` = 0x50bb8b44), block ~8,616,700 — extremely cheap, but per-message on-chain writes still don't scale; keep bodies off-chain.
- **Agent Council DAO** (best prior art for agent messaging): 4 agents each with a UP + shared council UP (LSP6) + ERC-8004 registry, but it **coordinates over centralized Rocket.Chat + emoji votes** — the chat layer is NOT decentralized/anchored. That gap is precisely what this integration targets.
- Identity names are **UP LSP3 `@name#hash` handles, not ENS**; no ENS-on-LUKSO.

## 1. Official LUKSO AI Agent Skill (lukso-network GitHub)

**Repo: `github.com/lukso-network/openclaw-universalprofile-authorize`**
(org description: "Universal Profile skill for Clawdbot - blockchain identity, NFT marketplace, DEX trading").
Root `SKILL.md` points to `skill/SKILL.md` — the real skill doc.
Source: https://raw.githubusercontent.com/lukso-network/openclaw-universalprofile-authorize/main/skill/SKILL.md

Frontmatter: `name: universal-profile`, `version: 0.9.0`, `author: frozeman` (Fabian Vogelsteller, LUKSO founder & ERC-20/ERC-725 author). Description: "Manage LUKSO Universal Profiles — identity, permissions, tokens, blockchain operations. Cross-chain support for Base and Ethereum."

**What it gives an agent (capabilities):**
- Full UP lifecycle: read/update LSP3 profile metadata, manage LSP6 controllers/permissions, LSP7/LSP8 token & NFT ops, DEX trading, cross-chain UP deployment (LSP23, same address on LUKSO/Base/Ethereum).
- `up` CLI: `up status`, `up profile info/configure`, `up key generate`, `up permissions encode/decode/presets`, `up authorize url`, `up quota`.
- Permission presets: `read-only`🟢 `token-operator`🟡 `nft-trader`🟡 `defi-trader`🟠 `profile-manager`🟡 `full-access`🔴.
- **LSP26 Follow/Unfollow** (on-chain social graph) built in — contract `0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA` on LUKSO mainnet.
- **LSP28 TheGrid** profile grid authoring (IFRAME/TEXT/IMAGES/X/INSTAGRAM/QR_CODE/ELFSIGHT tiles).
- **Forever Moments** integration (LUKSO-only social NFT platform, agent API `https://www.forevermoments.life/api/agent/v1`, 3-step build→prepare→sign&submit relay flow).
- Uses `@erc725/erc725.js` for all ERC725Y data read/encode/decode; IPFS gateway `https://api.universalprofile.cloud/ipfs/`.

**How it authenticates / key management:**
- Agent = a **controller EOA** (private key) authorized on a UP's LSP6 KeyManager with a permission bitmask. Not the UP owner key — a scoped delegate.
- Onboarding: create a profile at `my.universalprofile.cloud`, generate a controller key locally, authorize it via the Authorization UI `https://openclaw.universalprofile.cloud`. Permissions are **per-chain**.
- Credentials: `~/.openclaw/credentials/universal-profile-key.json` (chmod 600; key loaded only to sign then cleared); config at `~/.openclaw/skills/universal-profile/config.json`. JSON holds `universalProfile.address` + `controller.{address,privateKey}`.
- Chain endpoints baked in (see Networks table in §4).

**Messaging/agents:** No DM/chat primitive in the skill. The closest social primitives it exposes are **LSP26 follows** and **Forever Moments** (social NFT posts). Any messaging layer would be new.

## 2. Universal Profile App Repo(s) & Architecture

**Two consumer UP apps, both BETA** (confirmed docs.lukso.tech "Universal Profile Apps"):
- **UP Browser Extension** (Chrome/Brave/Edge) — desktop/laptop wallet-equivalent. **Source repo is NOT public** in the lukso-network org's recently-updated listing and the docs don't link a repo; treat the extension as closed/separate.
- **UP Mobile App** (iOS/Android) — on-the-go UP. No public source repo found; only `universalprofile-sample-ios-app` (a sample, no description) exists publicly.

**The main web UP app = `universaleverything.io`:**
- Repo: `github.com/lukso-network/universalprofile.cloud` (CI now under the `universal-everything` org). Prod at https://universaleverything.io/.
- Stack: **Vue 3 / Nuxt**, TypeScript, Tailwind, `yarn`, LUKSO design system `tools-web-components`, TanStack Query; deployed on **Cloudflare Pages**.
- Data: dual-mode — **GraphQL indexer (The Graph / Envio-style, default)** or direct **RPC**. Network switch via `?network=mainnet|testnet`.
- Features today: browse UPs, view LSP3 profile metadata, LSP5 assets (LSP7 tokens / LSP8 NFTs), network activity feed, connect & send assets, buy LYX. **No DM/chat feature in the app today.**
- Profile display: LSP3 metadata (name/avatar/links/tags) resolved via VerifiableURI → IPFS (gateway `api.universalprofile.cloud/ipfs/`). "Names" are UP `@name#hash` handles from LSP3, **not ENS** (LUKSO doesn't use ENS for UP identity; no ENS-on-LUKSO integration found).

**Related SDKs/packages seen:**
- `@lukso/up-provider` (`tools-up-provider`) — EIP-1193 provider so a dApp runs as a **mini-app inside a parent site/Grid**.
- `@lukso/activity-sdk` — transaction fetching/decoding/address-resolution/polling (private npm; used by `service-up-activity-feed-draft`, a **Vue 3 on-chain activity feed**: follows, transfers, profile updates).
- `@erc725/erc725.js`, `@lukso/lsp-smart-contracts`, `@lukso/lsp-utils`, `@lukso/tools-data-providers` (IPFS/Arweave).
- Mini-app templates: `miniapp-nextjs-template`, `miniapp-vite-react-template`, `miniapp-nuxt-template` ("build mini-apps for the Grid").

## 3. LSP Standards Relevant to Messaging

LSP map (from the skill's authoritative LSP table + verified interface IDs):

| LSP | Name | Purpose / relevance to messaging |
|---|---|---|
| LSP0 | ERC725Account | The UP smart-account itself (on-chain identity, holds data keys) |
| LSP1 | UniversalReceiver | **Notification hooks** — contract gets called on incoming assets/calls; a URD (UniversalReceiverDelegate) could route "you got a message" events |
| LSP2 | ERC725Y JSON Schema | Key encoding for arbitrary structured data under a UP |
| LSP3 | Profile Metadata | name, avatar, links, tags (VerifiableURI → IPFS JSON) |
| LSP4 | Digital Asset Metadata | token/NFT name/symbol/type + rich `LSP4Metadata` JSON (images, tags, createdAt) |
| LSP5 | ReceivedAssets | tracks tokens/NFTs owned by a UP |
| LSP6 | KeyManager | permission-based access control (controllers + bitmasks + AllowedCalls/AllowedERC725YDataKeys) |
| LSP7 / LSP8 | DigitalAsset / IdentifiableDigitalAsset | fungible / NFT (bytes32 tokenIds) |
| LSP9 | Vault | sub-account for asset segregation |
| LSP14 | **Ownable2Step** | two-step ownership transfer (interface `0x94be5999`). **CORRECTION:** NOT "Remote Caching"/decentralized storage — prior claim was wrong. Not a storage layer. |
| LSP23 | LinkedContractsFactory | deterministic cross-chain UP deployment (same address on LUKSO/Base/Eth) |
| LSP25 | ExecuteRelayCall | gasless meta-tx (LUKSO mainnet 42 + testnet 4201 ONLY); EIP-191 v0 signatures |
| LSP26 | **FollowerSystem** | **on-chain follow/unfollow social graph** — `0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA`. Closest existing "social" primitive. |
| LSP28 | TheGrid | customizable profile grid layout (profile homepage widgets) |

**Could a DM thread be represented as LSP metadata + signed off-chain payloads?**
- **Yes, plausibly, but nothing today does it.** A thread could be ERC725Y data keys on each participant's UP (LSP2 custom schema) pointing to a VerifiableURI (IPFS JSON of the message log), with per-message payloads signed EIP-191/EIP-1271 by the controller (LSP6 SIGN permission 0x200000). UP contracts support ERC-1271 `isValidSignature`, so message authenticity verifies on-chain against the UP, not just an EOA.
- **LSP1 UniversalReceiver** is the natural "inbox notification" rail: a sender routes a call to the recipient UP; the recipient's UniversalReceiverDelegate records/notifies. This is designed for asset receipt but is generic (`universalReceiver(bytes32 typeId, bytes data)`).
- **ENCRYPT/DECRYPT permissions (0x080000/0x100000)** exist in LSP6 as permission bits — the skill lists them but gives no E2E-encryption protocol; they are capability flags, not a messaging spec. A real encryption scheme (key exchange, ratchet) would be new.
- **Gap:** no LSP defines a conversation/thread, read receipts, or message ordering. All of that is net-new. LSP26 (follow) + LSP1 (receive hook) + LSP2/VerifiableURI (storage pointer) + ERC-1271 (auth) are the reusable building blocks.

## 4. Where Message Content Could Live (storage, DA, gas, paymaster)

**Networks (from skill, authoritative):**

| Chain | ID | RPC | Explorer | Relay (gasless) | Token |
|---|---|---|---|---|---|
| LUKSO mainnet | 42 | https://42.rpc.thirdweb.com | explorer.lukso.network | relayer.mainnet.lukso.network/api ✅ | LYX |
| LUKSO Testnet | 4201 | rpc.testnet.lukso.network | explorer.testnet.lukso.network | relayer.testnet.lukso.network/api ✅ | LYXt |
| Base | 8453 | mainnet.base.org | basescan.org | ❌ | ETH |
| Ethereum | 1 | eth.llamarpc.com | etherscan.io | ❌ | ETH |

LUKSO is an **L1 EVM chain (unmodified Ethereum)**: PoS beacon (teku/prysm/lodestar) + execution (geth/besu/erigon). No LUKSO-operated L2 found in the org repo scan (no `lukso-l2`-style repo); there is `network-optimism-integration-test` (experimental) and `lsp-bridge-HypLSP7` (Hyperlane LSP7 bridge) — bridges, not an official L2. UP works cross-chain on Base/Ethereum via LSP23 redeployment, not via a LUKSO rollup.

**Paymaster / gasless story:**
- On **LUKSO only**, LSP25 ExecuteRelayCall + the LUKSO relay service = gasless UX. Controller signs an LSP25 EIP-191 v0 message; relay submits `KeyManager.executeRelayCall()`. There is a **monthly relay gas quota** per UP (`up quota`; error `UP_QUOTA_EXCEEDED`). This is the "free gas for users" mechanism and is a strong fit for messaging (users shouldn't pay per message).
- Also `tools-lukso-permissionless.js` — ERC-4337 (account abstraction / paymaster) utilities built on viem, for AA-style gas sponsorship.
- On Base/Ethereum there is NO gasless path in the skill — controller must hold native ETH.

**Storage / data availability:**
- No LUKSO-native DA/rollup layer. Off-chain content standard is **IPFS**, referenced on-chain via **LSP2 VerifiableURI** (header `0x00006f357c6a0020` + keccak256 hash + UTF-8 url). LUKSO runs `service-ipfs-proxy` and the public gateway `api.universalprofile.cloud/ipfs/`; `tools-data-providers` supports IPFS + Arweave uploads.
- For messaging: large/opaque message bodies belong off-chain (IPFS/Arweave) with only a VerifiableURI (hash+pointer) or event on-chain. On-chain storage via `setData` is possible but costs gas per write and bloats UP state — unsuitable for high-volume chat.
- Gas on LUKSO mainnet: LYX fees are low; the skill characterizes LUKSO tx as "~free via relay" vs Base ~$0.001–0.01, Ethereum ~$0.10–1.00. (Live LYX gas price not re-queried this pass — see Gaps.)

## 5. Agent Council DAO — messaging prior art

(From the previous research pass; **not re-verified live this pass** — web_search provider was down and the site is a JS SPA not readable as text. Treat as prior art to confirm later.)
- "Agent Council DAO" (Synthesis hackathon, live on universaleverything.io): 4 AI agents, each with its own Universal Profile, plus a shared **council UP** governed by **LSP6 KeyManager** permissions; agents registered via **ERC-8004 Agent Registry**.
- **Messaging mechanism: coordination over a public Rocket.Chat instance + emoji-vote polls** — i.e. **centralized/off-chain chat**, with the *decisions* (votes/actions) executed on-chain through the shared UP's KeyManager. No evidence of on-chain anchoring of the chat messages themselves (no message hashes written to the UP found). This is the key limitation to improve on: the conversation layer is centralized; only governance outcomes touch chain.
- Relevance: validates "each agent = a UP + scoped controller" and "shared UP for group actions," but it does **not** demonstrate decentralized messaging — exactly the gap this integration would fill.
- TODO to verify: whether any message hash / Merkle root is committed on-chain, and whether they used LSP1 UniversalReceiver for notifications.

## 6. Key Repos (URL + description)

- https://github.com/lukso-network/openclaw-universalprofile-authorize — **the official UP AI-agent skill** (priority item): UP identity, permissions, tokens, DEX, LSP26 follows, Forever Moments; cross-chain Base/Eth.
- https://github.com/lukso-network/universalprofile.cloud — **universaleverything.io** web UP app (Vue/Nuxt, GraphQL indexer, Cloudflare Pages).
- https://github.com/lukso-network/service-up-activity-feed-draft — Vue 3 **on-chain activity feed** using `@lukso/activity-sdk` (follows/transfers/profile updates).
- https://github.com/lukso-network/tools-up-provider — `@lukso/up-provider`, EIP-1193 provider for **mini-apps inside the Grid**.
- https://github.com/lukso-network/lsp-smart-contracts — reference Solidity for all LSP standards (LSP0/6/7/8/26…).
- https://github.com/lukso-network/LIPs — LUKSO Improvement Proposals / LSP specs (standards source of truth).
- https://github.com/lukso-network/lsp-utils — helper utilities for LSP data.
- https://github.com/lukso-network/tools-data-providers — upload/download to **IPFS, Arweave** and others.
- https://github.com/lukso-network/service-ipfs-proxy — IPFS proxy API (the `api.universalprofile.cloud/ipfs/` gateway).
- https://github.com/lukso-network/tools-lukso-permissionless.js — viem-based **ERC-4337 account-abstraction / paymaster** utilities.
- https://github.com/lukso-network/tools-eip191-signer — sign EIP-191 Execute Relay Calls (LSP25 gasless).
- https://github.com/lukso-network/docs — LUKSO technical documentation (docs.lukso.tech).
- https://github.com/ERC725Alliance/erc725.js — `@erc725/erc725.js`, the ERC725Y read/encode/decode lib.
- https://github.com/lukso-network/example-forum-dapp — example **forum** dApp (closest "social posts" example).
- Related ecosystem (social-adjacent): **CommonGround** (app.cg/e/lukso), Universal.Page, UniversalSwaps.

## Verified facts (with sources)
- UP apps (extension + mobile) are BETA. Source: https://docs.lukso.tech/install-up-browser-extension/ (title "Universal Profile Apps").
- Official agent skill repo + full capabilities/auth. Source: https://raw.githubusercontent.com/lukso-network/openclaw-universalprofile-authorize/main/skill/SKILL.md
- Networks/RPCs/relay endpoints, LSP table, LSP14=Ownable2Step, LSP26 contract `0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA`. Source: same SKILL.md.
- Web UP app = universaleverything.io, Vue/Nuxt + GraphQL indexer + Cloudflare Pages. Source: https://raw.githubusercontent.com/lukso-network/universalprofile.cloud/main/README.md
- `@lukso/activity-sdk` on-chain feed (follows/transfers/profile updates). Source: https://raw.githubusercontent.com/lukso-network/service-up-activity-feed-draft/main/README.md
- Org repo inventory (names + descriptions). Source: https://api.github.com/orgs/lukso-network/repos (full JSON cached locally).
- Ecosystem dApps + libraries list. Source: https://raw.githubusercontent.com/lukso-network/awesome-lukso/main/README.md
- Live LUKSO mainnet gas ~1.35 Gwei, block ~8,616,700. Source: `eth_gasPrice`/`eth_blockNumber` via https://42.rpc.thirdweb.com (2026-10-20).

## Planned / speculative (clearly marked)
- **[SPECULATIVE — design idea, nothing exists]** DM thread as ERC725Y keys + VerifiableURI to an IPFS/Arweave message log; per-message EIP-191/ERC-1271 signatures verified against the UP; LSP1 UniversalReceiver as inbox hook.
- **[SPECULATIVE]** Use LSP6 ENCRYPT/DECRYPT permission bits with an app-level E2E scheme (no protocol defined on-chain today).
- **[PRIOR-PASS, UNVERIFIED THIS RUN]** Agent Council messaging details (Rocket.Chat + emoji votes, ERC-8004 registry, shared council UP). Needs live confirmation of any on-chain message anchoring.
- **[PLANNED/UNKNOWN]** UP mobile + extension are beta → feature set and any roadmap messaging feature not documented publicly.

## Gaps / open questions
1. **UP browser-extension & mobile-app source** are not public — can't inspect their architecture or injection points for a messaging UI. Need insider/private-repo access or to build as a **mini-app (up-provider)** instead of modifying the app.
2. **No conversation standard** (thread model, ordering, read receipts, E2E encryption) in any LSP — all net-new. Is there a draft LIP for messaging? (not found this pass).
3. **Agent Council on-chain anchoring** unconfirmed (web_search down this pass).
4. **Relay quota limits** for message-rate: what's the actual monthly LYX quota per UP, and does it tolerate chat-level tx volume?
5. **Data availability for message bodies**: IPFS pinning durability (who pins?), Arweave cost; no LUKSO-native DA layer.
6. **ENS/naming**: confirm there's truly no ENS-on-LUKSO and that LSP3 handles are the only identity names.
7. **Live LYX/USD** and realistic per-message cost if any on-chain write is required (hash commit vs full body).
8. **Cross-chain messaging**: UPs exist on Base/Eth too (no relay there) — is messaging LUKSO-only or multi-chain?
