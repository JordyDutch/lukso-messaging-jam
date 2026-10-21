# UP P2P — WebRTC messaging frontend

Browser dApp for a **private peer-to-peer channel (text · voice · video)**
between two LUKSO Universal Profiles. Identity is the UP; signaling is on-chain;
media flows directly P2P over WebRTC. No company server in the data path.

Implements `poc/up-wg-handshake/e2e-lab/FRONTEND-PLAN.md`. Layers 1–3 crypto are
ported 1:1 from `lab-crypto.mjs`; transport is browser-native WebRTC.

## Stack

- **Vite + React + TypeScript** (strict).
- **UP connection:** `@lukso/up-provider` + `ethers v6`. No ENS.
- **Crypto:** `@noble/curves` + `@noble/hashes`; AES-256-GCM via WebCrypto.
- **Transport:** `RTCPeerConnection` + `RTCDataChannel` (text) + `getUserMedia`
  audio/video tracks (voice/video), public STUN for ICE.
- **Signaling:** on-chain via RegistryV2/V3 — SDP announced as a **hash on-chain +
  sealed blob off-chain (IPFS, swappable)**.

## Run

```bash
cd frontend
npm install
npm run build        # tsc -b && vite build  — must succeed
npm test             # vitest — crypto + signaling encode/decode smoke tests
npm run dev          # local dev server
```

Config via env (see `.env.example`): `VITE_REGISTRY_ADDRESS`,
`VITE_IPFS_PUT_URL`, `VITE_IPFS_GATEWAY`. All have safe fallbacks.

## File map

```
frontend/
  index.html
  vite.config.ts  tsconfig*.json  .env.example
  contracts/
    RegistryV3.sol          ← RegistryV2 + WebRTC session/ICE fields (DEPLOY-READY, NOT deployed)
  src/
    main.tsx  App.tsx  styles.css  vite-env.d.ts
    lib/
      config.ts             ← chain 42, RPCs, STUN, Envio, registry address
      crypto.ts             ← layers 1-3 ported 1:1 from lab-crypto.mjs + webrtc-dtls-v1 branch
      offer.ts              ← signed+sealed WebRTC offer/answer envelope
      webrtc.ts             ← RTCPeerConnection / DataChannel / media / fingerprint
      blobStore.ts          ← off-chain sealed-SDP store (IPFS | in-memory stub)
      registry.ts           ← RegistryV2/V3 ABI + announce/convPubOf
      signaling.ts          ← hash-on-chain + blob-off-chain publish/fetch/watch
      rpc.ts                ← read provider w/ RPC fallback
      names.ts              ← @name -> address via Envio search_profiles_v2
      up.ts                 ← UP connect + deterministic X25519 conv key
    state/app.tsx           ← app-wide state (session / screen / call)
    screens/                ← Connect · Announce · Lobby · Call
    components/FingerprintBadge.tsx
  test/crypto.test.ts       ← 8 passing smoke tests
```

## What works / what's stubbed / what needs on-chain deploy

### ✅ Works (built + verified here)

- **Build:** `npm run build` succeeds (tsc strict + vite). Output in `dist/`.
- **Tests:** `npm test` — 8/8 pass. They exercise the CI-runnable paths:
  - static-static X25519 ECDH conversation key is symmetric (both sides derive
    the same key); threadId symmetric.
  - AES-256-GCM seal/open roundtrip + tamper rejection (WebCrypto).
  - derivation-path **domain separation** (`wg-x25519-v1` vs `webrtc-dtls-v1`
    never collide) + determinism.
  - sealed WebRTC offer envelope: recipient opens, recovers SDP + fingerprint,
    verifies the EIP-191 signer; **forged sender (MITM) is rejected**.
  - hash-on-chain + blob-off-chain shape: `bodyHash === keccak256(blob)`, store
    roundtrips.
- **Crypto port:** `lab-crypto.mjs` layers 1–3 ported 1:1 to the browser (only
  change: `node:crypto` AES-GCM → WebCrypto, which makes seal/open async).
- **UI:** all four screens (Connect → Announce → Lobby → Call) render and wire to
  the libs; mute/camera toggles, text pane, connection-state + fingerprint badge,
  hang-up (tears down the peer + stops/wipes media tracks).

### ⚠️ Stubbed / can't be exercised in CI

- **Real 2-browser call.** A genuine P2P connect needs two real browsers with
  UP extensions + a deployed RegistryV3 + a networked blob store; it cannot run
  in CI. The crypto + signaling **encode/decode** paths around it ARE tested; the
  live connect is marked in the Call screen when RegistryV3 is absent.
- **Deterministic DTLS certificate — intentional deviation (see below).** The
  cert uses a random keypair (browser API limitation); identity binding is
  achieved by UP-signing the *actual* fingerprint and announcing it, which gives
  the same anti-MITM property. `deriveDtlsSeed` (the `webrtc-dtls-v1` branch)
  exists + is unit-tested; swapping to a real derived cert is a one-liner once a
  browser exposes RTCCertificate key import.
- **Off-chain blob store.** Default is an in-memory content-addressed stub
  (`MemoryBlobStore`) — works in one browser / tests only, NOT networked. Set
  `VITE_IPFS_PUT_URL`/`VITE_IPFS_GATEWAY` to use real IPFS (`IpfsBlobStore`).
- **Gasless.** Users pay their own gas (announce + session). LSP25 relay is
  planned, not wired.
- **No TURN.** Public STUN only → the ~20% of symmetric-NAT networks won't
  hole-punch (hurts voice/video most). The UI should surface an honest
  "your network can't connect directly" message; user-reachability fallback
  (public IP / port-forward) + a dedicated TURN are deferred (decided with B).

### 🚧 Needs on-chain deploy

- **RegistryV3** (`frontend/contracts/RegistryV3.sol`) — **yes, RegistryV2 must be
  extended.** The live lab RegistryV2
  (`0xA5Beb9FF6F1977F0FF62ac13b074548dF7012fcC`) has `announce`/`convPubOf` +
  lobby `invite` (200 B body cap) but **no SDP/ICE session fields**. RegistryV3
  is a superset (V2 surface byte-identical) adding:
  - `announceSession(to, threadId, bodyHash, blobRef, kind, expiry)` + event
    `SessionAnnounced` — the WebRTC offer/answer signal (hash on-chain, sealed
    SDP blob off-chain).
  - `announceIce(to, threadId, candRef)` + event `IceAnnounced` — trickle ICE.

  Deploy RegistryV3, then set `VITE_REGISTRY_ADDRESS` to its address. Until then
  the app runs, lets you connect + announce (against live V2), and gates the
  WebRTC call path behind an honest "signaling contract not yet deployed" banner
  (`REGISTRY_V3_DEPLOYED` in `config.ts`). **No keys here — nothing is deployed.**

## Deviations from FRONTEND-PLAN.md (flagged)

1. **DTLS cert not byte-deterministic.** The plan wanted
   `RTCPeerConnection({certificates:[derivedCert]})` from an HKDF-derived key.
   No browser API imports an externally-derived private key into an
   `RTCCertificate` today, so a byte-deterministic cert is impossible with stock
   APIs. We keep the `webrtc-dtls-v1` HKDF branch (derived + unit-tested) and
   achieve the actual goal — **identity↔channel binding / anti-MITM** — by
   EIP-191-signing the real negotiated fingerprint and announcing it on-chain,
   then pinning it. Same security property, different mechanism. One-line swap
   the day the API exists. Full rationale in `src/lib/webrtc.ts`.

Everything else follows the plan: Vite+React+TS, up-provider+ethers v6, noble
crypto ported 1:1, WebRTC transport, hash-on-chain + IPFS blob signaling, the
four screens, chain 42 + thirdweb/lukso RPC fallback, users pay own gas,
RegistryV2 extended (not the lab one mutated).
