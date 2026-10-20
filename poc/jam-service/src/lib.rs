// message_service — a JAM service SKELETON for UP↔UP messaging.
//
// ⚠️ STATUS: STUB / design artifact. This does NOT compile against a real JAM
//    SDK yet — no stable public JAM service SDK/ABI existed as of 2026-10-20
//    (see ../../research-jam.md). It encodes the *shape* a developer must fill in
//    on a JAM DUNA / Toaster testnet. The imports below are illustrative names.
//
// KEY FACT (research-jam.md §Execution model): a JAM service has exactly TWO
// entry points — `refine` (in-core, parallel, stateless) and `accumulate`
// (on-chain, shared state). There is NO `on_message` primitive. All message
// handling is application logic layered on these two. We implement:
//
//   refine     -> validate a DeliverMessage work package (shape + EIP-191 sig
//                 proving the UP controller authorized it). Stateless.
//   accumulate -> append the validated message to the recipient's inbox in the
//                 service's shared storage. On-chain.
//   (reads)    -> ReadInbox is a state query, served from accumulated storage.
//
// The matching runnable JS model lives in ../relay/mock-jam-service.js; keep the
// two in sync. See docs/RUN-JAM.md for how to deploy this on a 6-validator DUNA.

#![allow(dead_code, unused_variables)]

// --- Illustrative JAM service bindings (replace with the real crate once it exists) ---
// e.g. `use jam_pvm_sdk::{accumulate, refine, Service, WorkItem, WorkOutput, StateDb};`
mod jam_stub {
    //! Minimal placeholder types standing in for the JAM PVM SDK surface.
    pub type Hash = [u8; 32];
    pub type Address = [u8; 20];

    /// A work item handed to `refine` (produced by the relay's SubmitBundleToCore).
    pub struct WorkItem {
        pub payload: Vec<u8>, // SCALE/JSON-encoded WorkPackage (see message_format below)
    }
    /// Output of `refine`, consumed by `accumulate`.
    pub struct WorkOutput {
        pub ok: bool,
        pub data: Vec<u8>,
    }
    /// Shared-state handle available only during `accumulate`.
    pub trait StateDb {
        fn get(&self, key: &[u8]) -> Option<Vec<u8>>;
        fn set(&mut self, key: &[u8], value: &[u8]);
    }
}
use jam_stub::{Address, Hash, StateDb, WorkItem, WorkOutput};

/// The anchored-message work package the relay forwards (mirror of relay.js).
/// Encoded as the WorkItem payload. In production use SCALE codec.
pub struct DeliverMessage {
    pub thread_id: Hash,
    pub from: Address,     // UP (LSP0) address of the sender
    pub to: Address,       // UP address of the recipient
    pub content_hash: Hash, // keccak256 of the off-chain (IPFS) body
    pub nonce: u64,
    pub sig: Vec<u8>,      // EIP-191 signature by the UP controller (LSP6 SIGN)
    pub digest: Hash,      // keccak256(abi.encode(thread_id,to,content_hash,nonce))
}

// =====================================================================
// ENTRY POINT 1: refine  (in-core, parallel, STATELESS)
// =====================================================================
/// Validate the work package. MUST NOT touch shared state. Mirrors
/// MockJamService.refine(): shape check + recover EIP-191 signer == `from`.
pub fn refine(item: WorkItem) -> WorkOutput {
    // 1. decode item.payload -> DeliverMessage        (TODO: SCALE/JSON decode)
    // 2. recompute digest = keccak256(abi.encode(thread_id, to, content_hash, nonce))
    //    and assert it equals msg.digest.
    // 3. recover signer from (digest, sig) using the EIP-191 personal-sign prefix
    //    (secp256k1 ecrecover). For a UP smart account the real check is ERC-1271
    //    isValidSignature against `from` — but that needs a LUKSO state proof, so
    //    here we verify the controller EOA signature the relay forwards and defer
    //    full ERC-1271 to the trust-minimized bridge phase (Phase 3, DESIGN.md).
    // 4. return ok=true + the canonical message bytes for accumulate.
    WorkOutput { ok: true, data: Vec::new() } // STUB
}

// =====================================================================
// ENTRY POINT 2: accumulate  (on-chain, SHARED STATE)
// =====================================================================
/// Commit the refined message to the recipient inbox. Replay-guarded by
/// (from, nonce), mirroring the on-chain MessageAnchor nonce. Mirrors
/// MockJamService.accumulate().
pub fn accumulate(db: &mut dyn StateDb, outputs: Vec<WorkOutput>) {
    for out in outputs {
        if !out.ok {
            continue;
        }
        // let msg = decode(out.data);
        // let seen_key = [b"seen:", from, nonce].concat();
        // if db.get(&seen_key).is_some() { continue; }   // replay guard
        // db.set(&seen_key, &[1]);
        // inbox key = [b"inbox:", to].concat(); append msg (length-prefixed list).
        // db.set(&inbox_key, &appended);
    }
}

// =====================================================================
// READS: ReadInbox  (state query, not an entry point)
// =====================================================================
/// Served by the node's state query RPC, not by refine/accumulate.
/// key = "inbox:" ++ recipient_address ; returns the length-prefixed message list.
pub fn read_inbox_key(recipient: Address) -> Vec<u8> {
    let mut k = b"inbox:".to_vec();
    k.extend_from_slice(&recipient);
    k
}

// message_format (canonical, also documented in docs/DESIGN.md):
//   { threadId: bytes32, from: address, to: address, contentHash: bytes32,
//     nonce: u64, sig: bytes, digest: bytes32 }
