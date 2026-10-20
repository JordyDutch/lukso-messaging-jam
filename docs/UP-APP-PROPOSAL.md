# UP App — feature proposal: native UP⇄UP messaging (nightly build)

_Audience: the Universal Profile app team (via Fabian / frozeman). Draft for forwarding._

## Summary

Add **direct messages between Universal Profiles** to the UP app, using only
existing LUKSO primitives for a shippable Phase 1 (no JAM, no new L1 feature).
Identity = UP address; authenticity = the UP's existing controller signature
(ERC-1271 / LSP6 SIGN); bodies off-chain (IPFS) with an on-chain metadata anchor.
A reference contract + working end-to-end PoC is in this repo (`poc/`).

## Why this fits the UP app

- No messaging primitive exists in any LSP today (verified — see
  `research-lukso.md`), but LSP1/LSP2/LSP6/ERC-1271 + IPFS are enough to build it.
- The app already resolves LSP3 profiles and VerifiableURI→IPFS; the chat UI reuses
  that stack (Vue/Nuxt + GraphQL indexer).
- Gasless UX is already available on LUKSO via **LSP25 ExecuteRelayCall** + the
  LUKSO relayer (per-UP quota) — users shouldn't pay per message.

## What to add to the nightly build (concrete)

1. **A mini-app slot for chat.** Ship the messaging client as a Grid mini-app via
   `@lukso/up-provider` (prototype: `poc/up-minapp/index.html`). Lowest-risk path —
   no change to the closed app core; it loads like other mini-apps.
2. **Inbox notifications via LSP1 `UniversalReceiver`.** Define a message `typeId`
   so a sender's anchor call (or the relayer) pings the recipient UP's
   UniversalReceiverDelegate → the app surfaces a "new message" badge. This is the
   one piece that benefits from app-core support (push/badge).
3. **Agent access via the official skill.** Let an agent authorized as an LSP6
   controller (the `lukso-network/openclaw-universalprofile-authorize` skill, by
   frozeman) send/read DMs through the same contract — so agents and humans share
   one inbox. The controller already holds SIGN; add the anchor contract to its
   AllowedCalls.
4. **Anchor contract.** Deploy `poc/evm-side/contracts/MessageAnchor.sol` (or a
   reviewed successor) to LUKSO testnet (4201) first. Bodies → IPFS via the existing
   `api.universalprofile.cloud/ipfs/` gateway; store the VerifiableURI pointer.

## Explicitly NOT required for Phase 1

- No JAM. JAM is an optional Phase 2+ availability/compute backbone (see DESIGN.md);
  it is not needed to ship chat and is not production-ready (see `research-jam.md`).
- No new LSP standard needed to start — though a LIP for a message/thread schema
  would be the right long-term home for interop.

## Open questions for the app team

- Is there appetite to expose an LSP1 message `typeId` + notification hook in core?
- Relay quota headroom for chat-rate traffic (per-UP monthly LYX quota)?
- Preferred E2E encryption approach (the LSP6 ENCRYPT/DECRYPT bits exist but no
  protocol is defined) — app-level X25519/double-ratchet keyed off the UP?

## Pointers

- Reference contract + run: `poc/evm-side/` (compiles, runs on a local EVM).
- Full pipeline (anchor → relay → JAM-shaped service → inbox): `poc/relay/`.
- Client prototype: `poc/up-minapp/index.html`.
- Design + roadmap: `docs/DESIGN.md`. Answers to the premise questions: `docs/FAQ.md`.
