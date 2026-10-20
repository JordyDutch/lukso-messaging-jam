// mock-jam-service.js — an in-memory stand-in for a JAM service.
//
// It deliberately mirrors the JAM service model from research-jam.md:
//   - JAM services have exactly TWO entry points: `refine` and `accumulate`.
//     There is NO `on_message` primitive. Message handling is app logic on top.
//   - refine()   : in-core, parallel, stateless validation/transform of a work
//                  package. Here: verify the work package shape + the sender's
//                  EIP-191 signature (the ERC-1271/LSP6 proof forwarded by the relay).
//   - accumulate(): on-chain, against shared state. Here: append the validated
//                   message to the recipient's inbox (the service's shared state).
//
// Swap this class for a real JAM service deployed on a DUNA/Toaster testnet; the
// relay would then SubmitBundleToCore instead of calling refine()/accumulate().
// See ../jam-service/ for the Rust skeleton and docs/RUN-JAM.md.
'use strict';
const { ethers } = require('ethers');

class MockJamService {
  constructor() {
    this.inboxes = new Map(); // recipient(lowercased) -> [message]
    this.seen = new Set(); // (from:nonce) replay guard mirrored in the service
  }

  // ENTRY POINT 1: refine — stateless, parallelizable, no shared-state writes.
  // Returns a "work report" (ok + reason) exactly like a refine stage would.
  refine(wp) {
    for (const k of ['threadId', 'from', 'to', 'contentHash', 'nonce', 'sig', 'digest']) {
      if (wp[k] === undefined) return { ok: false, reason: `missing field ${k}` };
    }
    let recovered;
    try {
      recovered = ethers.verifyMessage(ethers.getBytes(wp.digest), wp.sig);
    } catch (e) {
      return { ok: false, reason: 'bad signature encoding' };
    }
    if (recovered.toLowerCase() !== wp.from.toLowerCase()) {
      return { ok: false, reason: 'signature does not match sender UP controller' };
    }
    return { ok: true, report: { from: wp.from, to: wp.to, nonce: wp.nonce } };
  }

  // ENTRY POINT 2: accumulate — writes to the service's shared state (inboxes).
  accumulate(wp, report) {
    const key = `${wp.from.toLowerCase()}:${wp.nonce}`;
    if (this.seen.has(key)) return { ok: false, reason: 'replay (already accumulated)' };
    this.seen.add(key);
    const to = wp.to.toLowerCase();
    if (!this.inboxes.has(to)) this.inboxes.set(to, []);
    this.inboxes.get(to).push({
      threadId: wp.threadId,
      from: wp.from,
      contentHash: wp.contentHash,
      nonce: wp.nonce,
    });
    return { ok: true };
  }

  // Read API the UP mini-app would call (maps to a JAM service state query).
  readInbox(recipient) {
    return this.inboxes.get(recipient.toLowerCase()) || [];
  }
}

module.exports = { MockJamService };
