# E2E lab — UP identity → WireGuard, fully end-to-end (LUKSO mainnet 42)

Isolated proving ground that closes the last gap (recipient-side **decryption**)
and shows the whole chain working on real mainnet, without touching the existing
infra (host `wg0` and the production registry `0xcCAB…3B81` are untouched).

## Result (2026-10-21) — PASS, twice

```
identity (UP secp256k1) → announce X25519 conv-pubkey ON-CHAIN
  → sealed+signed WG offer posted to registry (lobby invite, ≤200 B)
  → recipient reads invite body + sender conv-pubkey FROM CHAIN
  → recipient DECRYPTS endpoint + verifies EIP-191 signature
  → both derive ephemeral WG keys → REAL wg Noise handshake + encrypted ping
```

- RegistryV2 (adds `announce`): **`0xA5Beb9FF6F1977F0FF62ac13b074548dF7012fcC`** (deploy `0xdcf3fcee…`).
- Two fresh controllers we fully control: alice `0x2211…0506`, bob `0x3C97…5B87` (keys in `keys/`, gitignored).
- Announces: alice `0x63c26554…`, bob `0xb00f68ad…`. Invite A→B `0x04b233ae…`, reply B→A `0x12381f45…`.
- Tunnel: real kernel WireGuard in a **rootless user+net namespace**, Noise handshake completes, ping 0% loss, rx/tx bytes move. Re-run gives fresh ephemeral keys + a new tunnel — repeatable, not a fluke.
- Cost: ~0.20 LYX total (2× 0.1 top-ups to the controllers; gas negligible).

## The gap this closed
The board/lobby scripts one level up sealed with a **sender-only** HKDF key, so
the recipient could verify authenticity but not decrypt. Here the conversation
key is a **real static-static X25519 ECDH** between the two parties' announced
conv-keys (`lab-crypto.mjs → conversationKey`), so BOTH sides derive the same
AES-256-GCM key and the recipient genuinely decrypts. Authenticity still comes
from the secp256k1 EIP-191 signature carried inside the sealed payload.

## Files
- `LobbyRegistryV2.sol` — LobbyRegistry + on-chain `announce(convPub)`.
- `lab-crypto.mjs` — shared crypto (WG derivation, real ECDH conv-key, seal/open, build/open offer).
- `e2e-loop.mjs` — the orchestrator (fund → deploy → announce → invite → decrypt → tunnel). Idempotent via `e2e-state.json`.
- `wg-tunnel-test.sh` — raises a real wg tunnel from derived keys in a rootless netns; PASS on handshake + ping.
- `keys/`, `run/`, `e2e-state.json` — gitignored (secrets / local).

## Run
```bash
cd poc
node up-wg-handshake/e2e-lab/e2e-loop.mjs            # dry: off-chain crypto + size check, no spend
BROADCAST=1 node up-wg-handshake/e2e-lab/e2e-loop.mjs # real: tops up controllers, runs on mainnet, raises tunnel
```

## Isolation guarantees
- No `sudo`; the tunnel runs inside `unshare --user --map-root-user --net` — host networking (incl. `wg0`) is invisible and untouched.
- New registry + new controllers; production `0xcCAB…3B81` and the funded signer are only used to top up the lab controllers (0.1 LYX each).

See `FRONTEND-PLAN.md` for the proposed UI, pending B's build decision.
