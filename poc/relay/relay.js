// relay.js — the L2 relayer/availability layer (see docs/DESIGN.md).
//
// Responsibility: watch the LUKSO anchoring contract, turn each MessageAnchored
// event into a JAM "work package", and submit it to a JAM service. In this PoC
// the JAM service is MockJamService (refine/accumulate in memory); in production
// the relay would SubmitBundleToCore on a JAM DUNA/Toaster node via JSON-RPC.
//
// Trust note (from research-jam.md): a relayer is the only path feasible TODAY.
// It is trusted/semi-trusted. It CANNOT forge messages here, because it forwards
// the controller's EIP-191 signature and the JAM service re-verifies it in refine().
// The relay only chooses *whether/when* to forward (liveness), not authenticity.
'use strict';
const { ethers } = require('ethers');

class Relay {
  // `chain` is anything exposing getLogs(fromBlock) + an ethers Interface `iface`.
  // Swap LocalChain for an ethers.JsonRpcProvider + contract.queryFilter — same shape.
  constructor(chain, jamService, { log = console.log } = {}) {
    this.chain = chain;
    this.jam = jamService;
    this.iface = chain.iface;
    this.cursor = 0; // next block to scan
    this.sigs = new Map(); // from:nonce -> signature (submitted by clients out-of-band)
    this.log = log;
  }

  // Clients hand the relay the controller signature for a message they anchored.
  // (On-chain we store only metadata to save gas; the sig travels via the relay
  // or alongside the IPFS body — see DESIGN.md "security model".)
  submitSignature(from, nonce, sig) {
    this.sigs.set(`${from.toLowerCase()}:${nonce}`, sig);
  }

  // Rebuild the exact digest the controller signed, from on-chain event fields.
  _digest(threadId, to, contentHash, nonce) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'bytes32', 'uint256'],
        [threadId, to, contentHash, nonce]
      )
    );
  }

  // Poll new logs once; forward each as a work package. Returns count forwarded.
  async poll() {
    const logs = this.chain.getLogs(this.cursor + 1);
    let forwarded = 0;
    for (const lg of logs) {
      const ev = this.iface.parseLog(lg);
      if (!ev || ev.name !== 'MessageAnchored') continue;
      const { threadId, from, to, contentHash, nonce } = ev.args;
      const digest = this._digest(threadId, to, contentHash, nonce);
      const sig = this.sigs.get(`${from.toLowerCase()}:${nonce}`) || null;

      const wp = {
        kind: 'jam.work_package/deliver_message',
        threadId,
        from,
        to,
        contentHash,
        nonce: Number(nonce),
        digest,
        sig,
      };
      this.log('[relay] work package ->', JSON.stringify({ from: wp.from, to: wp.to, nonce: wp.nonce }));

      // JAM service: refine (stateless verify) then accumulate (shared-state write).
      const refined = this.jam.refine(wp);
      if (!refined.ok) {
        this.log('  [jam.refine] REJECT:', refined.reason);
        continue;
      }
      const acc = this.jam.accumulate(wp, refined.report);
      this.log('  [jam.accumulate]', acc.ok ? 'inbox += 1' : 'REJECT: ' + acc.reason);
      if (acc.ok) forwarded += 1;
    }
    if (logs.length) this.cursor = Math.max(this.cursor, ...logs.map((l) => l.blockNumber));
    return forwarded;
  }
}

module.exports = { Relay };
