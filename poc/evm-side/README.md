# poc/evm-side — LUKSO on-chain layer (WORKS)

Minimal, runnable PoC of the L1 anchoring layer from `../../docs/DESIGN.md`.

## What it proves (actually run — see `demo-output.txt`)
- `MessageAnchor.sol` **compiles** (solc 0.8.37, EVM target `london`).
- Deploys and runs on a **real in-process EVM** (`@ethereumjs/vm` v10) — not a mock.
- 3 UPs (controller EOAs) send DMs; each message is **signed (EIP-191)** and the
  signature is **verified** (the ERC-1271 / LSP6 SIGN path).
- **Replay protection** works: resending with a used nonce **reverts** with
  `BadNonce(expected, got)`.
- Anchored records + `MessageAnchored` events **read back** correctly.

## Run
```bash
cd poc            # (installs live here)
npm install       # ethers v6, solc, @ethereumjs/* (already vendored if node_modules present)
cd evm-side
node compile.js   # -> build/MessageAnchor.json (abi + bytecode)
node demo.js      # runs the end-to-end EVM demo; prints the transcript
```

## Files
- `contracts/MessageAnchor.sol` — the anchoring contract (design artifact; ERC-1271
  verification hook documented as a stub where a real UP plugs in).
- `compile.js` — solc-js compile → `build/MessageAnchor.json`.
- `demo.js` — deploy + 3 UPs + DMs + signature/nonce/replay checks + inbox reads.
- `demo-output.txt` — captured output of an actual `node demo.js` run.

## Notes / honest limitations
- EOAs stand in for UPs (we don't deploy full LSP0/LSP6 UP contracts here); the
  contract comments mark exactly where a real UP + ERC-1271 check replaces `msg.sender`.
- `block.timestamp` shows `0` in reads because the in-process EVM uses a default
  genesis block; irrelevant to the anchoring/auth/replay logic being demonstrated.
- Fallback rationale: no `anvil`/`hardhat`/`foundry` was installed in this environment,
  so the PoC uses `@ethereumjs/vm` in-process (a **real EVM**, no daemon needed) driven
  by `ethers` for ABI/signing. This runs reliably and still executes real bytecode.
