# LUKSO mainnet flow — what to deploy, where to connect

Date: 2026-10-21. Companion to `docs/DESIGN.md` (architecture) and
`docs/CONTINUATION-FABIAN.md` (pickup). Diagram: `docs/diagrams/mainnet-sequence.html`
(open in a browser).

## TL;DR

To run UP↔UP DMs on LUKSO mainnet you deploy **2 contracts**, run **2 services**,
and ship **1 client**. No JAM, no LUKSO team involvement, no permission needed
(anything here is public infra: LUKSO RPC, the public LSP25 relay, IPFS, ENS).

| # | Artifact | Where | Repo status |
|---|---|---|---|
| 1 | `MessageAnchor` (contract, ~110 lines of Solidity) | LUKSO mainnet, chain 42 | **built + tested** (`poc/evm-side`, in-process EVM) |
| 2 | `CASH` ERC-20 (the "CASH" of the devnet flow) | LUKSO mainnet | **planned** (plain ERC-20; or reuse any token) |
| 3 | IPFS pinning (self-hosted or a pinning service) | our infra | **planned** (PoC keeps ciphertext in memory) |
| 4 | Relay service (event watcher → inbox) | our infra (1 VPS) | **built + tested** (`poc/relay`, needs real RPC swap) |
| 5 | Client (UP mini-app / web app) | users' phones/browsers | **prototype** (`poc/up-minapp`, localStorage stand-in) |
| 6 | (optional) JAM service behind the relay | JAM testnet → mainnet | **stub** (`poc/jam-service`) — Phase 2, when SDK lands |

## What to deploy (concrete)

### 1. MessageAnchor — the only on-chain piece
- Deploy with Foundry/Hardhat to chain 42. One tx, ~50 KB bytecode, fees ~1.35 Gwei
  LYX (verified live 2026-10-20) → negligible (fractions of a cent).
- No admin, no storage, no per-message state growth beyond `nonceOf` + per-thread
  anchor arrays. **Bodies never touch the chain.**
- Keep `from = msg.sender` in v1 (the UP's LSP6 KeyManager executes the call); the
  ERC-1271 `_verifyUP` hook (already stubbed in the contract) is the optional
  trust-upgrade later.
- Verify: `forge test` (port the PoC demo assertions), deploy, read back
  `nonceOf` via `explorer.lukso.network`.

### 2. CASH ERC-20
- v1 of the flow doesn't strictly need a custom token — any ERC-20 (or LYX itself)
  works for "in-chat transfers". A custom `CASH` is purely brand/UX.
- The **conversation gate is app-side** (verified in the spike): the client refuses
  to attach a transfer to a non-existent thread. On-chain, it's an ordinary ERC-20
  transfer with the `threadId` in `data` (or a `transferWithMemo`-style call).
- If you want the gate trustlessly: add a tiny `ChatGate` contract that only
  accepts transfers whose `threadId` has ≥1 anchored message. Optional.

### 3. IPFS (bodies)
- Self-host: a small pinning node (or use a pinning API). Bodies are the **ciphertext
  envelope** (AES-GCM, ~tens of bytes for text) — pinning cost is trivial.
- `contentHash` on-chain = keccak256 of the envelope (the PoC already does this;
  in production hash the CID or the raw envelope — pick one, it's a constant).

### 4. Relay service (our infra, one VPS is fine)
- **Swap one file:** `poc/relay/local-chain.js` → `ethers.JsonRpcProvider` at the
  LUKSO RPC. The relayer is written *only* against `getLogs()` — drop-in (verified
  in the PoC; the shape is identical to `queryFilter`).
- It does: poll `MessageAnchored` → re-verify the forwarded EIP-191 signature
  (off-chain ERC-1271 against the UP) → append to the inbox store → (Phase 2) emit a
  JAM work package via `SubmitBundleToCore`.
- Inbox store v1: Postgres or a key-value DB keyed by `(threadId, recipient)`.
- Trust note: the relay is **trusted for liveness only** — it cannot forge messages
  because authenticity is the controller's signature, re-verified by the service.

### 5. Client
- Production vehicle: **Grid mini-app inside the UP app** via `@lukso/up-provider`
  (UP app is closed-source BETA — `docs/UP-APP-PROPOSAL.md` is the feature request).
- Interim (shippable now): standalone web app + UP browser extension (the existing
  `poc/up-minapp/index.html` prototype, wiring block already matches `relay.js`).
- Client responsibilities (all in `poc/devnet-adapter/`): local name index
  (ENS/`.dot`) + autocomplete, X25519 conversation keys, encrypt, upload to IPFS,
  sign (LSP6), submit via **LSP25 gasless** (user never pays gas), poll inbox,
  CASH gate.

## Where to connect (verified endpoints, 2026-10-20)

| Thing | Endpoint | Notes |
|---|---|---|
| LUKSO mainnet RPC | `https://42.rpc.thirdweb.com` | verified live (gas ~1.35 Gwei LYX, block ~8.6M); official alternative: `rpc.lukso.network` |
| Explorer | `explorer.lukso.network` | verify deployments |
| Gasless relay (LSP25) | `https://relayer.mainnet.lukso.network/api` | public LUKSO relay; **monthly LYX quota per UP** (`UP_QUOTA_EXCEEDED` when exhausted) — the "users pay no gas" rail |
| Names | ENS (LUKSO) and/or DotNS `.dot` | feed the autocomplete index; resolve + index registration events |
| Bodies | self-hosted IPFS | pinning service |
| Testnet first | chain 4201, `rpc.testnet.lukso.network`, `relayer.testnet.lukso.network/api` | same contracts, same code, zero risk — do v1 here first |
| (Phase 2) JAM | Toaster/Tart testnet, `SubmitBundleToCore` via JSON-RPC | only when the public SDK lands (`docs/RUN-JAM.md`) |

## The flow, step by step (see diagram)

1. **Discover:** Alice types "bob" → autocomplete from her local index (ENS/`.dot`
   names → UP addresses). No chain call per keystroke — that's the trick.
2. **Thread:** open chat → `threadId = keccak256(sorted(A,B))` (deterministic, same
   in client, anchor, and JAM).
3. **Encrypt:** X25519 conversation key for `threadId`; AES-256-GCM envelope.
4. **Store:** upload envelope to IPFS → `contentHash`.
5. **Sign:** Alice's UP (LSP6 KeyManager) signs the digest
   `keccak256(abi.encode(threadId, to, contentHash, nonce))` — EIP-191 v0 (LSP25).
6. **Anchor (gasless):** LUKSO relay submits `KeyManager.executeRelayCall(anchor(...))`
   within Alice's monthly quota. Chain checks the per-sender nonce (replay-safe) and
   emits `MessageAnchored`.
7. **Forward:** our relay sees the event, re-verifies the signature off-chain,
   writes the inbox (→ JAM work package in Phase 2).
8. **Deliver:** Bob's app polls (or gets pushed via LSP1 UniversalReceiverDelegate
   on his UP), fetches the envelope by hash from IPFS, decrypts with his half of the
   conversation key. Done — E2E; nobody in between can read it (spike: outsider
   GCM-auth fails ✓).
9. **CASH:** Alice sends CASH → client checks the thread exists (the devnet rule) →
   LSP25 gasless ERC-20 transfer with `threadId` in `data`, rendered in-chat.

## PoC → mainnet delta (what actually changes)

| PoC (today) | Mainnet (to do) |
|---|---|
| `LocalChain` (in-process EVM) | `ethers.JsonRpcProvider` @ LUKSO RPC (drop-in) |
| `MockDirectory` (in-memory) | ENS/DotNS resolver + registration-event indexer |
| Map-based CASH ledger | real ERC-20 |
| in-memory Bulletin store | Postgres/inbox DB + IPFS bodies |
| static X25519 keys | X3DH / Double Ratchet (forward secrecy) |
| `MockJamService` | keep as-is until JAM SDK lands, then `coreplay` |

## Risks / open questions (honest)

- **Relay quota:** the public LSP25 relay has a per-UP monthly gas quota; chat-level
  message volume may hit it. Mitigations: batch anchors (one tx per burst), or run
  our own relayer for paying users. **Verify the actual quota before committing.**
- **UP app is closed-source BETA** — the mini-app depends on the UP team accepting
  the proposal (`docs/UP-APP-PROPOSAL.md`); the standalone web app is the fallback.
- **Static keys** in the PoC E2EE are NOT forward-secret; replace before any real
  user data (X3DH/Double Ratchet).
- **Trust boundary:** app-side rules (CASH gate) are bypassable by a determined
  client; the trustless floor is the anchor (nonce + contentHash). Acceptable for v1.
- **JAM is out of v1** — it's a Phase-2 availability layer behind the relay; nothing
  in the client or L1 changes when it lands.
