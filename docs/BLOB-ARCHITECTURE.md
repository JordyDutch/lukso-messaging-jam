# UP Dawg — Blob (EIP-4844) Architecture Proposal

Status: **PROPOSAL — not implemented.** Decision pending B.
Author: Z · 2026-10-22 · chain: LUKSO mainnet (42)

This document explores using EIP-4844 **blob transactions** to carry large,
*ephemeral* payloads for UP Dawg while anchoring a **permanent on-chain hash**,
so the chain stays the trust/verifiability root without paying to store bulk
bytes forever. It is a design study. No contract or frontend code here is live.

---

## 0. TL;DR

- **Blobs are a cheap, large, _temporary_ data lane.** ~128 KB each, up to 6 per
  tx (~768 KB), and on LUKSO today the blob base fee sits at the **1 wei floor**
  (blob usage is literally zero) — so a blob is effectively free right now.
- **The EVM cannot read blob bytes.** A contract sees only the blob's 32-byte
  *versioned hash* via the `BLOBHASH` opcode. Blobs are pruned by nodes after
  **~18 days** (`MIN_EPOCHS_FOR_BLOB_SIDECARS` = 4096 epochs ≈ 18 days).
- **Therefore the pattern is: body-in-blob (ephemeral) + hash-on-chain (permanent).**
  The chain permanently proves *"a message with content hash H existed at time T,
  posted by UP X to thread Y"*; the content itself lives in the blob for ~18 days
  and, if you want it kept, in any cache/indexer that grabbed it in that window.
- **Good fit:** throwaway or short-lived bulk data — WebRTC signaling SDP,
  large attachments, media, group-broadcast blobs, "stories" that are meant to
  expire. **Bad fit:** the durable public Wall feed, which promises permanent
  readable history.
- **Recommendation:** keep text posts/DMs as calldata+event (permanent, already
  working). Adopt blobs as an **opt-in lane for large/ephemeral payloads**, with
  the on-chain hash anchor. Ship the hash-anchor hooks in the contract now
  (cheap, forward-compatible); turn on the browser blob-send path later.

---

## 1. What EIP-4844 actually gives us

| Property | Value | Source |
|---|---|---|
| Blob size | 128 KB (4096 field elements × 32 B) | EIP-4844 |
| Blobs per tx | up to 6 (target 3, max 6) | EIP-4844 / network params |
| Max payload/tx | ~768 KB | derived |
| Contract visibility | **versioned hash only**, via `BLOBHASH` opcode | EIP-4844 |
| Blob bytes in EVM | **never** — not in calldata, not in state | EIP-4844 |
| Retention | pruned after ~**18 days** (4096 epochs) | consensus spec |
| Cost | separate `blob_gas` market; LUKSO now = **1 wei/blob-gas (floor)** | live `eth_blobBaseFee` |
| Tx type | **Type 3** (`blobVersionedHashes`, `maxFeePerBlobGas`) | EIP-4844 |
| Client need | KZG commitments/proofs (trusted setup) to build the sidecar | EIP-4844 |

**LUKSO support — verified live 2026-10-22:**
- Latest block header carries `blobGasUsed`, `excessBlobGas`,
  `parentBeaconBlockRoot` → Cancun/Deneb (4844) is active.
- `eth_blobBaseFee` → `0x1` (1 wei).
- `eth_feeHistory` → `baseFeePerBlobGas: ["0x1","0x1",...]`,
  `blobGasUsedRatio: [0,0,0]` → blobs active but **completely unused**.

So we can send Type-3 txs today and pay ~nothing for blob space. The only cost
that matters is the normal execution gas of the anchoring call (~small).

### The hard constraint that shapes everything

A contract **cannot** read a blob. `BLOBHASH(i)` returns the i-th blob's
versioned hash (`0x01 ++ sha256(kzg_commitment)[1:]`). That's it. You cannot
`keccak256` the content on-chain, cannot index it, cannot gate logic on its
bytes. Verification of "this hash corresponds to this content" is done
**off-chain** by whoever has the blob (or a cache of it), using KZG.

Consequence: any "integrity" the contract enforces is over the *blob hash you
pass in as calldata*, cross-checked against `BLOBHASH(0)` so a caller can't
anchor a hash for a blob they didn't actually attach. The mapping
**content → blob** stays a client/indexer responsibility.

---

## 2. Three candidate designs

### Design A — Status quo (no blobs): calldata + event

What's live today. Body ≤1024 B rides in calldata, re-emitted in `Posted`.
Frontend reads from event logs. Permanent, simple, no KZG, no pruning.

- ✅ Permanent, verifiable, zero new tooling.
- ❌ ~740 gas/byte; 1 KB cap; bulk/media impossible.

Keep this for **text posts and DMs**. (See Wall v2 note in §5 — we're dropping
the redundant `bodyOf` SSTORE, a ~73% gas cut, independent of blobs.)

### Design B — Body-in-blob + hash-on-chain (the proposed blob lane)

For a large or ephemeral message, the client:
1. Builds a 128 KB blob holding the (encrypted) body.
2. Computes the KZG commitment → versioned hash `H`.
3. Sends a **Type-3 tx** calling `postBlob(tag, encrypted, threadId, H, meta)`.
4. Contract checks `H == BLOBHASH(0)` (caller really attached this blob),
   stores a tiny `Post` record + emits `PostedBlob(id, from, tag, …, H)`.

Readers:
- Within ~18 days: fetch the blob by hash from a consensus/blob node or a blob
  explorer, verify KZG against `H`, decrypt.
- After pruning: the **hash + metadata survive forever** on-chain; the content
  survives only if an indexer/pinner saved it (IPFS, S3, the recipient's client
  cache, etc.). For *ephemeral-by-design* content that's exactly right.

- ✅ Up to ~768 KB/tx, ~free blob space on LUKSO, permanent proof-of-existence.
- ✅ No 1 KB cap; no per-byte calldata gas for the body.
- ⚠️ Content is ephemeral (~18 days) unless separately pinned.
- ⚠️ Needs KZG in the browser (`kzg-wasm`/`c-kzg`) + Type-3 support.
- ⚠️ **Blocker to confirm:** a UP posts via `LSP0.execute` (KeyManager →
  target). The blob sidecar lives at the **outer EOA tx** (the controller's
  Type-3 tx), not the inner `execute` call. `BLOBHASH` reads the *current tx's*
  blobs regardless of call depth, so `postBlob` inside `execute` still sees
  `BLOBHASH(0)` — **but only if the UP extension can originate a Type-3 tx.**
  Today's UP browser extension almost certainly **cannot build blob sidecars**
  (no KZG, no Type-3 in the wallet). This likely forces, for now, either
  (a) blob posts only from a raw controller EOA (our tooling), not the UP
  extension, or (b) an "outer EOA attaches blob, inner call is a normal UP
  execute that anchors a hash passed as calldata" split where we DON'T use
  `BLOBHASH` and instead trust the client — weaker. **Needs a spike.**

### Design C — Hash-only on-chain, body off-chain in blob *via a relay*

Like B, but a small relayer/EOA (ours) wraps the user's signed intent into the
Type-3 tx. Keeps UP-extension UX (user just signs a message), moves KZG/Type-3
to our infra. **Re-introduces a backend/relayer** — violates the "frontend-only"
goal. Document it only as a fallback if B's UP-extension Type-3 blocker proves
fatal and we still want blobs.

- ✅ Keeps UP-extension UX, blobs for bulk.
- ❌ Needs a relayer (backend) → not frontend-only. Trust/liveness on relayer.

---

## 3. Recommended architecture

**Two lanes, one feed, hash as the spine:**

```
 TEXT post / DM            →  Design A: calldata + event (permanent)     ← keep
 LARGE / EPHEMERAL payload →  Design B: blob body + on-chain hash anchor ← add later
                                        (SDP signaling, media, stories)
```

- **The on-chain record is always permanent and always carries a content hash.**
  For calldata posts the hash is `keccak256(body)` (optional, computable from the
  event). For blob posts the hash is the KZG versioned hash `H`.
- This makes the chain a uniform, permanent **index/proof layer**: every message
  — tiny or huge, permanent-body or ephemeral-body — has `(id, from, tag,
  threadId, timestamp, contentHash, lane)` on-chain forever. The *body* is either
  inline (lane=calldata) or in a blob/pin (lane=blob).
- **Ephemeral-by-design content** (WebRTC SDP, "stories") simply lets the blob
  prune; the hash remains as tamper-evident proof it happened.
- **Keep-forever content** that still wants the blob lane (big media) must be
  **pinned** by a client/indexer within 18 days (IPFS CID can even equal the
  anchored hash for a clean story).

### Best first use: P2P signaling via blobs (optional, later)

The WebRTC offer/answer SDP is the ideal blob candidate: inherently throwaway
(useless seconds after the DataChannel opens), currently squeezed under the
1 KB DM cap with custom SDP compression (`sdp.ts`). A blob could carry the full
uncompressed SDP (+ ICE) with room to spare, pruned automatically. We'd anchor
only its hash on-chain (or keep signaling entirely peer-discovered). This
removes the SDP-compression fragility. Not needed today — current compressed-DM
signaling works — but it's the cleanest win if we adopt blobs.

---

## 4. On-chain surface (proposed, forward-compatible)

Ship these hooks in **Wall v2 now** (cheap, unused until the client lane turns
on). They add no cost to existing text posts.

```solidity
// Anchor a blob-carried body. The body itself is NOT on-chain; only its
// KZG versioned hash is. Caller MUST attach exactly the blob whose hash is
// `blobHash` as the first blob of this Type-3 tx.
event PostedBlob(
    uint256 indexed id,
    address indexed from,
    address indexed tag,
    bool    encrypted,
    bytes32 threadId,
    uint64  timestamp,
    bytes32 blobHash,   // EIP-4844 versioned hash (0x01||sha256(commitment)[1:])
    bytes   meta        // tiny: mime/len/nonce, NOT the body
);

function postBlob(
    address tag,
    bool encrypted,
    bytes32 threadId,
    bytes32 blobHash,
    bytes calldata meta
) external {
    require(meta.length <= 256, "meta too big");
    // Anti-spoof: the anchored hash must be a blob actually attached to THIS tx.
    // blobhash(0) == 0 when the tx carries no blob (e.g. a normal Type-2 call),
    // which lets us also accept a "hash-only, body pinned off-chain elsewhere"
    // mode if we choose — but when a blob IS attached we bind to it.
    bytes32 attached = blobhash(0); // Solidity >=0.8.24 global `blobhash`
    if (attached != bytes32(0)) {
        require(blobHash == attached, "hash != attached blob");
    }
    uint256 id = _nextId();
    // store tiny record only (from, tag, flags, threadId, blobHash) — no body
    emit PostedBlob(id, msg.sender, tag, encrypted, threadId,
                    uint64(block.timestamp), blobHash, meta);
}
```

Notes:
- `blobhash(index)` is the Solidity global (Cancun, ≥0.8.24) wrapping the
  `BLOBHASH` opcode. **Requires the deploy to target the Cancun EVM** — LUKSO is
  Cancun/Deneb, confirmed by the header fields.
- `meta` holds only small framing (content length, mime tag, encryption nonce /
  scheme id), never the body.
- We can store a `bytes32 blobHash` in the `Post` struct too if we want the
  getter/verifiability, at +1 SSTORE (~20k gas) — optional.

---

## 5. Relationship to Wall v2 (the gas cut, already decided)

Independent of blobs, Wall v2 **removes the redundant `bodyOf` mapping**. The
current contract stores the body in state (`bodyOf[id]=body`) *and* in the event;
the frontend reads only the event. Dropping the SSTORE:

| Body | v1 gas | v2 gas (event-only) | cut |
|---|---|---|---|
| 256 B DM | 308k | ~120k | ~61% |
| 1024 B max | 863k | ~230k | ~73% |

(Measured v1 numbers are live; v2 numbers are the calldata+event lower bound.)
Wall v2 is where the `postBlob` hooks above should land, so we deploy once.

---

## 6. Open questions / spikes before implementing

1. **UP-extension Type-3 support (critical).** Can the UP browser extension
   originate an EIP-4844 blob tx (build KZG sidecar, sign Type-3)? Almost
   certainly **no** today. If no: blob posts are limited to raw-EOA tooling or
   need a relayer (Design C, not frontend-only). **Spike:** attempt a Type-3
   `execute` from the extension; else from a controller EOA with `kzg-wasm`.
2. **`blobhash` under `LSP0.execute`.** Confirm the opcode reads the outer tx's
   blobs across the KeyManager→target call depth (spec says yes — it's tx-scoped
   — but verify on LUKSO with a testnet shot).
3. **Blob retrieval path for a frontend-only reader.** Which LUKSO
   node/explorer serves historical blobs by hash within 18 days? Is there a blob
   explorer (blobscan-equivalent) on LUKSO, or must we run a consensus node with
   blob sidecars? If none, "read other users' blob bodies" needs a pinning story.
4. **Pinning for keep-forever blob content.** If we want big media durable:
   IPFS (CID == anchored hash?) or the recipient's client caching on receipt.
5. **KZG in the browser bundle.** `kzg-wasm` size/trusted-setup load time on a
   static site; acceptable for a lazy-loaded "attach large file" path.

---

## 7. Decision asks for B

- [ ] Approve the **two-lane model** (text = calldata+event permanent; large/
      ephemeral = blob + on-chain hash)?
- [ ] Ship the **`postBlob` hash-anchor hooks in Wall v2** now (forward-compatible,
      no cost to text posts), client lane OFF until spikes pass?
- [ ] First blob target: **P2P signaling SDP** (cleanest), **large attachments**,
      or **expiring "stories"**?
- [ ] OK to run the **UP-extension Type-3 spike** on LUKSO **testnet** to settle
      open question #1 before committing the browser path?
```