# RUN-JAM.md — deploying the message service on a JAM testnet

> STATUS: **unverified / not executed.** This is a step-by-step a developer would
> follow; none of it was run in this PoC (no JAM node was installed). It is
> distilled from `../research-jam.md`. Every command below should be re-checked
> against the upstream repo before relying on it. The runnable artifact in this
> repo is the **JS mock** (`poc/relay/mock-jam-service.js`), not this Rust skeleton.

## What is verified vs not

- **Verified (from research):** JAM services expose exactly `refine` + `accumulate`
  (no `on_message`); apps submit **work packages** to a core over **JSON-RPC**;
  the `jam-duna/coreplay` bundle stands up a local 6-validator testnet and has a
  working FIB work-package demo (`Work package SUBMITTED`, JSON-RPC ports 19800+).
- **NOT verified:** the exact JAM service SDK/ABI, the SCALE wire format for a
  work package, and whether `src/lib.rs` compiles against any real crate. No
  stable public JAM PVM service SDK was found as of 2026-10-20.

## Prerequisites

- A JAM node bundle. Per research the most concrete is **`jam-duna/coreplay`**
  (redirected from `jam-duna/jamtestnet`): downloadable node binaries + a local
  multi-validator testnet + sample genesis services (`fib.jam`, authorizers).
- Rust toolchain targeting **PVM (RISC-V)** once the real SDK exists (PVM is a
  RISC-V VM, not EVM — see research-jam.md).

## Steps (developer PoC path)

1. **Stand up a local JAM testnet** (6 validators), per the `jam-duna/coreplay`
   README (e.g. `jamduna run` / its Makefile targets). Confirm JSON-RPC is up on
   ports `19800–19805`.
2. **Build the service** into a PVM blob. Replace the stub deps in `Cargo.toml`
   with the real JAM SDK; implement the `refine`/`accumulate` bodies marked
   `TODO` in `src/lib.rs` (decode, digest recompute, ecrecover, inbox append).
   Produce `message_service.jam` (analogous to the shipped `fib.jam`).
3. **Register the service** in genesis (or via the node's service-registration
   path) so it gets a service id + coretime, following how `fib.jam` is wired.
4. **Submit a work package** (one anchored message) to a core via JSON-RPC — the
   same call the FIB demo logs as `SubmitBundleToCore … SUCCESS`. Payload = the
   `DeliverMessage` work package from `poc/relay/relay.js`.
5. **Observe accumulate** write the message to the recipient inbox in shared
   state; **query the inbox** via the node's state-query RPC using the key from
   `read_inbox_key(recipient)`.

## Swapping the mock for the real service

In `poc/relay/relay.js`, `this.jam` is a `MockJamService` with `refine()` /
`accumulate()`. To go real:
- Replace those two calls with a single **`SubmitBundleToCore`** JSON-RPC call to
  the JAM node (the node runs `refine` then `accumulate` for you).
- Replace `MockJamService.readInbox()` with a **state-query RPC** to the node.
- Keep the work-package JSON shape identical (`relay.js` already builds it); only
  the transport changes (in-process call → JSON-RPC).

## References (from research-jam.md)

- `jam-duna/coreplay` — https://github.com/jam-duna/coreplay (local testnet + FIB demo)
- JAM Conformance Dashboard — https://paritytech.github.io/jam-conformance-dashboard/
- Parity execution model — https://www.parity.io/blog/jam-what-it-is-how-it-works
- "The Road to JAM" (Offchain Messaging) — https://forum.polkadot.network/t/the-road-to-jam/18621
