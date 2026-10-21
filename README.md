# LUKSO × JAM — decentralized messaging for Universal Profiles

Open-source research + working proofs for **private, peer-to-peer messaging
between LUKSO Universal Profiles** — identity-gated, end-to-end encrypted, with
signaling on-chain and **no company server in the data path**. Polkadot **JAM**
is explored as an optional availability/compute backbone, not a requirement.

> **Status:** research + runnable PoCs + a **fully end-to-end proof on LUKSO
> mainnet**. Everything below is marked **verified** (ran it / on-chain) or
> **planned/stub**. Contributions welcome — see [Contributing](#contributing).

---

## What this is

A way for two Universal Profiles to open a **private channel — text, voice,
video** — where:

- **Identity** is the UP itself (secp256k1 controller key, EIP-191 signatures). Unforgeable, no accounts, no phone numbers.
- **Discovery / signaling** happens **on-chain** (LUKSO) instead of a central server — the chain is the rendezvous.
- **The conversation is end-to-end encrypted** and flows **directly peer-to-peer**; infrastructure (if any) only relays ciphertext, never sees content.

The relationship graph (who contacted whom) is public on-chain by design; only
message **content** is private. That trade-off is deliberate.

## Architecture (current)

The system is **4 layers**. Identity, signaling and the sealed key-exchange are
stable and proven; only the **transport** evolved.

| layer | role | how |
|---|---|---|
| **1. Identity** | "I am UP 0x…" | UP controller key, EIP-191 signature, verified on-chain / ERC-1271 |
| **2. Signaling** | find + rendezvous | peers **announce** on-chain in a registry contract (conversation pubkey, then the session offer) — LUKSO is the signaling server |
| **3. Secret exchange** | agree a shared key, prove authenticity | **static-static X25519 ECDH** between announced conversation keys → shared AES-256-GCM key; the session offer is **sealed + EIP-191-signed** so the recipient both decrypts and verifies the sender |
| **4. Transport** | move the bytes, E2E encrypted | **WebRTC** DataChannel (text/files) + audio/video tracks (DTLS-SRTP), hole-punched P2P via public STUN |

**Why WebRTC for transport.** The goal is a private conversation channel, not a
full-device VPN. WebRTC runs natively in the browser (just the UP extension — no
helper, no root), has ICE/STUN built in, and carries text + voice + video on one
encrypted peer connection. We bind it to identity by deriving the WebRTC DTLS
key deterministically from the UP key
(`HKDF(UP_privkey, salt=nonce, info="webrtc-dtls-v1"‖path)`) and announcing the
UP-signed DTLS fingerprint on-chain — which closes anti-MITM for voice/video,
something raw WebRTC does not give on its own.

**Where JAM fits.** JAM is **not required**. LUKSO alone provides every primitive
needed (identity, on-chain anchor/signaling, LSP25 gasless, LSP1 notifications).
JAM is kept as an **optional, swappable** availability/compute layer behind a
relayer boundary — useful later, droppable any time. See `docs/DESIGN.md` and
`docs/RUN-JAM.md`.

<details>
<summary>Earlier architecture (historical: anchor-on-IPFS messaging + JAM relayer)</summary>

The project began as a store-and-forward design: a `MessageAnchor` contract
storing `{from,to,contentHash,ts,nonce}` with bodies on IPFS, a relayer emitting
a work package per message, and JAM as an optional Phase-2 backbone. That design
(and its runnable PoC under `poc/evm-side`, `poc/relay`, `poc/devnet-adapter`)
still lives in the repo and in `docs/DESIGN.md`; the Polkadot **Product Devnet**
app remains our UX reference. The project since moved from store-and-forward
messaging toward **live P2P channels** (the layers above), which is what the
mainnet proof and the current frontend plan target.
</details>

## Proven end-to-end on LUKSO mainnet (chain 42)

A standalone lab closes the hardest part — the recipient genuinely decrypting —
and runs the whole chain on real mainnet, in isolation (no existing infra
touched). Repeated twice, idempotent:

```
UP identity (secp256k1)  →  announce X25519 conv-pubkey ON-CHAIN
  →  sealed + signed session offer in the registry
  →  recipient reads it FROM CHAIN, DECRYPTS, verifies the EIP-191 signature
  →  both derive an ephemeral session key  →  real encrypted P2P link + traffic
```

- Registry (adds on-chain `announce`): `0xA5Beb9FF6F1977F0FF62ac13b074548dF7012fcC`.
- Transport in the lab was **real kernel WireGuard** (Noise handshake + encrypted ping, 0% loss) in a **rootless user+net namespace** — the example that proved layers 1–3. The production transport is **WebRTC** (same layers 1–3, swapped layer 4).
- Code + write-up: `poc/up-wg-handshake/e2e-lab/` (`README.md`, `lab-crypto.mjs`, `e2e-loop.mjs`, `wg-tunnel-test.sh`). Secrets (`keys/`, `*-state.json`) are gitignored.

**Why keep the WireGuard lab?** It is the realized proof of the identity→key→E2E
stack (layers 1–3 port to WebRTC unchanged) and the option for a future
full-device-VPN mode.

## Frontend plan (next, not yet built)

A browser dApp + UP extension; WebRTC transport; signaling on-chain. Decisions
taken: SDP as a **hash on-chain + sealed blob off-chain (IPFS)**; users pay their
own gas for now (gasless LSP25 relayer later); **extend RegistryV2** with SDP/ICE
fields; ship first as a **tab in the existing dashboard**. Full plan:
`poc/up-wg-handshake/e2e-lab/FRONTEND-PLAN.md`.

## Repo map

```
README.md                         ← you are here
research-lukso.md                 ← LUKSO/UP landscape, LSPs, official agent skill
research-jam.md                   ← JAM execution model, testnet, EVM interop
research-polkadot-messaging.md    ← how people DM on Polkadot devnet vs prod (+ correction)
docs/
  DESIGN.md                       ← full design: reqs, layers, msg format, security, roadmap
  FAQ.md                          ← design questions answered + "what this is NOT"
  MAINNET-FLOW.md                 ← LUKSO mainnet flow: what to deploy, where to connect
  ADAPTERS.md                     ← devnet-primitive → LUKSO/UP mapping
  UP-APP-PROPOSAL.md              ← feature request / PR outline for the UP app team
  RUN-JAM.md                      ← how to deploy the optional JAM service (verified-vs-not)
  CONTINUATION-FABIAN.md          ← historical addendum (original handoff context)
  diagrams/mainnet-sequence.html  ← sequence diagram (open in a browser)
poc/
  up-wg-handshake/                ← current: UP-identity-gated P2P + e2e-lab (mainnet proof)
    e2e-lab/                      ← fully-E2E lab + FRONTEND-PLAN.md
  lukso-mainnet/ , evm-side/ ,    ← earlier working PoCs (anchor + relay + devnet adapters)
  relay/ , devnet-adapter/ ,         kept as reference for the store-and-forward design
  jam-service/                    ← STUB: Rust JAM service skeleton (refine/accumulate)
  up-minapp/                      ← PROTOTYPE: standalone HTML chat mini-app (up-provider)
```

## Run the proofs

```bash
cd poc && npm install                                   # ethers v6, solc, noble, etc.

# Current: UP identity → on-chain → P2P, fully E2E (dry run = no spend)
node up-wg-handshake/e2e-lab/e2e-loop.mjs               # off-chain crypto + size check
# BROADCAST=1 node up-wg-handshake/e2e-lab/e2e-loop.mjs # real mainnet run (needs a funded key)

# Earlier store-and-forward PoCs
cd evm-side && node compile.js && node demo.js          # L1 anchor + auth + replay demo
cd ../relay && node pipeline.js                          # EVM → relay → mock-JAM → inbox
cd ../devnet-adapter && node devnet-spike.js             # Product-Devnet chat flow on LUKSO
```

`BROADCAST=1` runs spend real LYX and need a funded controller key — never commit
keys; see the secrets note in `poc/up-wg-handshake/e2e-lab/README.md`.

## Verified vs planned

- **Verified (ran it / on-chain):** full E2E on mainnet 42 — announce, sealed+signed offer, recipient decrypt + signature verify, ephemeral key derivation, real encrypted P2P link (WireGuard lab, ping 0% loss), repeated twice. Earlier: `MessageAnchor` compiles + executes on an in-process EVM; EIP-191 verified; replay reverts; relay→mock-JAM pipeline delivers; devnet-adapter X25519 E2EE + conversation-gated CASH spike. Proofs in `poc/*/*-output.txt` and the e2e-lab README.
- **Planned / stub:** the WebRTC browser frontend (plan only); on-chain SDP/ICE registry fields; URD access-mode enforcement (private / follow-gated / open); dedicated TURN for symmetric NAT (public/optional + user-reachability fallback for now); on-chain replay/TTL enforcement; `poc/jam-service` (no public JAM SDK to build against yet); LSP25 gasless relayer.

## Contributing

Issues and PRs welcome. Please keep the honesty convention: mark new claims
**verified** (with a runnable proof or an on-chain tx) or **planned/stub**. Don't
commit private keys — the e2e-lab `keys/` and `*-state.json` are gitignored for
that reason. Design discussion belongs in `docs/DESIGN.md` and `docs/FAQ.md`.

## License

[MIT](LICENSE) © 2026 m8b-dev.
