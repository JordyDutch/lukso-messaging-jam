# poc/relay — relayer + mock JAM service (WORKS)

Runnable PoC of the full pipeline from `../../docs/DESIGN.md`:

```
client sign (EIP-191/LSP6) → anchor() on LUKSO → relay watches event
   → work package → JAM.refine (verify sig) → JAM.accumulate → recipient inbox
```

## Run
```bash
cd poc/relay
node ../evm-side/compile.js   # ensure build/MessageAnchor.json exists
node pipeline.js              # full EVM → relay → mock-JAM → inbox demo
```
Captured output: `pipeline-output.txt`.

## Files
- `local-chain.js` — a "local node" stand-in wrapping the in-process EVM; exposes an
  `eth_getLogs`-shaped `getLogs()` so the relay is written against a swappable interface.
- `relay.js` — the L2 relayer: watches `MessageAnchored`, rebuilds the signed digest
  from event fields, attaches the controller signature, emits a **work package**, and
  submits it to the JAM service (`refine` then `accumulate`). Replay-safe on re-poll.
- `mock-jam-service.js` — in-memory JAM service mirroring the **real** JAM model:
  only `refine` (stateless verify) + `accumulate` (shared-state inbox write). **No
  `on_message`.** `readInbox()` is a state query.
- `pipeline.js` — wires it all together and prints per-recipient inboxes.

## Swapping the mock for a real JAM service
- In `relay.js`, `this.jam.refine()/accumulate()` → one `SubmitBundleToCore` JSON-RPC
  call to a JAM DUNA/Toaster node (the node runs refine+accumulate for you).
- `mock-jam-service.readInbox()` → the node's state-query RPC.
- Swap `LocalChain` for `new ethers.JsonRpcProvider(<LUKSO RPC>)` + a `Contract` +
  `queryFilter(MessageAnchored)` — the `getLogs` shape is identical.
- Full steps + verified-vs-not status: `../../docs/RUN-JAM.md`.

## Trust note
The relayer is **trusted for liveness only**, not authenticity: it forwards the
controller's signature and the JAM service re-verifies it in `refine()`, so a relay
**cannot forge** messages — it can only choose whether/when to forward. This is the
only EVM↔JAM path feasible today (research-jam Option (b)).
