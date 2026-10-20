# Adapters: how a UP gets the Product Devnet chat flow (UP × .dot)

Date: 2026-10-20. Code: `poc/devnet-adapter/` (runs: `node devnet-spike.js`).
Goal: make a LUKSO Universal Profile app behave like the Polkadot Product Devnet
app — user search with autocomplete, E2EE DMs, conversation-gated token transfers —
**without depending on Polkadot**, by translating each observed devnet primitive to
its LUKSO/UP equivalent behind a small adapter interface.

## The mapping (devnet primitive → LUKSO/UP adapter)

| Product Devnet (observed) | LUKSO/UP equivalent | Adapter file | Status |
|---|---|---|---|
| Personhood pseudonym + `.dot` name in a searchable directory | UP address + ENS (or DotNS `.dot`) name; off-chain index for search | `identity.js` (`MockDirectory`) | mock — swap for ENS/DotNS resolver |
| User autocomplete ("type a → users on a…") | Prefix index over registered names (client-side; no chain call per keystroke) | `identity.js` `searchUsers()` | **trick verified in spike** |
| Encrypted chat (X25519 KEX, upg. Sept 2026) | X25519 ECDH + AES-256-GCM, key per `threadId` | `e2ee.js` | **verified in spike (incl. negative check)** |
| CASH (testnet token, faucet top-up) | Any ERC-20 on LUKSO testnet (e.g. a dev token) | `chat.js` ledger (faucet/balance) | mock ledger — swap for ERC-20 |
| "Can't send CASH until you start a conversation" | App-level gate on existing `threadId` (NOT a protocol rule) | `chat.js` `sendCash()` | **verified in spike (gate rejects, then allows)** |
| Bulletin chain data store + storage allowances (PGAS) | IPFS/Arweave bodies + per-sender byte budget | `chat.js` (ciphertext-only store) | mock store — swap for IPFS |
| Message ordering/replay | `MessageAnchor` per-sender nonce on LUKSO (already built) | `poc/evm-side` + `poc/relay` | **verified** |

## The five tricks that make it "smigac"

1. **One conversation, many backends, one `threadId`.** The thread id is the
   deterministic `keccak256` of the *sorted* pair of participant addresses
   (identical to `poc/relay/local-chain.js`). The app-side store, the LUKSO anchor,
   and (later) the JAM inbox all key off the same id — so a single DM is anchored in
   every backend with zero coordination. **Proven in the spike (section 8: MATCH ✓).**

2. **Autocomplete is an off-chain index, not a chain query.** The devnet app
   suggests users per keystroke; a chain lookup per keystroke would be slow and paid.
   The trick: maintain a local index of `{pseudonym, .dot, address}` (synced from
   ENS/DotNS resolution + registration events) and do prefix matches locally.
   `searchUsers()` does exactly this; the real adapter only needs to *feed* it.

3. **Conversation-gated transfers are state, not protocol.** "No CASH before you
   chat" is enforced by checking `threads.has(threadId(a,b))` before allowing a
   transfer — a plain app-level rule (the on-chain transfer is ordinary). This gives
   the devnet's anti-spam/UX behavior with **zero protocol changes**; the same rule
   can later live in a UP-owned contract if you want it trustlessly.

4. **Ciphertext-only store (PGAS-like).** The Bulletin-style store keeps only the
   AES-GCM envelope (no plaintext), with a per-sender byte allowance that blocks
   writes when exhausted — mirroring the devnet's storage-allowance mechanics.
   Outsiders get a GCM auth failure, not an error message (spike section 9 ✓).

5. **The relayer is the seam.** Because the app and the chain share `threadId` and
   the body is referenced by hash, the existing `poc/relay` (LUKSO events → JAM work
   packages) can forward devnet-style chats to JAM *unchanged*. Swap `MockJamService`
   for a real `coreplay` service when the SDK lands — nothing above the relay changes.

## How to actually attach to the real Product Devnet (optional spike)

If the goal is to *join* the live devnet rather than replicate it on LUKSO:

- The app is the PCF/Parity **Polkadot Product Devnet** (pre-production; "expect
  chaos"; the Sept 2026 update wiped contacts/messages and forced new usernames).
- Its three primitives are `cash`, `messaging`, `identity` over the **Bulletin chain**
  + CDM contract registry + Asset Hub + People.
- The network endpoints / RPC URLs / API surface for its messaging are **not
  publicly documented** (as of this research pass) — the realistic path is to
  reverse-engineer the app's requests (it's a testnet, designed for this) and wrap
  them in the same `identity`/`messaging`/`cash` adapter interface. A client that
  implements the interface can then talk to *either* backend (devnet or LUKSO) —
  which is exactly the property the mock demonstrates.
- Access: APK via Firebase App Distribution, iOS via TestFlight, desktop via
  `github.com/Polkadot-Community-Foundation/polkadot-desktop-community`.

## Honest limits (do not overclaim)

- `e2ee.js` uses **static** X25519 keys (no forward secrecy). Production: X3DH /
  Double Ratchet (Signal protocol) — e.g. a `libsignal`/`textsecure` port or the
  `sframe`/`vls`-style libs. The interface is ready for the swap.
- `MockDirectory` is in-memory; the real index needs persistence + event sync.
- The CASH ledger is a Map; the real token is an ERC-20 (or the devnet's own asset).
- The gate, E2EE and store are **app-side** — a determined client can bypass them.
  The trustless floor is the LUKSO anchor (nonce + contentHash), which cannot be
  bypassed without the controller key.
