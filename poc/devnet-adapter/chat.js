// chat.js — the "messaging" + "cash" primitives, shaped like the Product Devnet app.
//
// Mirrors the observed app rules (2026-10-20, PCF forum + live app usage):
//   1. User discovery = directory autocomplete (identity.js).
//   2. CASH transfers are allowed ONLY inside an existing conversation
//      ("you can't send CASH until you start a conversation" — an APP-LEVEL UX
//      rule, not a protocol constraint; the on-chain transfer itself is ordinary).
//   3. Message bodies (ciphertext) live in a Bulletin-style store with per-user
//      storage allowances (PGAS-like); running out blocks further writes.
//   4. Bodies are E2EE (X25519 + AES-256-GCM): only the two participants can read.
//
// threadId derivation is IDENTICAL to poc/relay/local-chain.js, so one conversation
// exists simultaneously in this Bulletin store AND on LUKSO (MessageAnchor) with the
// same thread id — the "one inbox, many backends" adapter property (docs/ADAPTERS.md).
'use strict';
const { ethers } = require('ethers');
const { conversationKey, encrypt, decrypt } = require('./e2ee');

// Same derivation as LocalChain._threadId: keccak256 of the sorted pair of addresses.
function threadIdOf(a, b) {
  const [lo, hi] = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
  return ethers.solidityPackedKeccak256(['address', 'address'], [lo, hi]);
}

class DevnetChat {
  /**
   * @param directory  IdentityAdapter (identity.js)
   * @param identities map: lowercased address -> e2ee identity (e2ee.js makeIdentity())
   * @param opts.allowance per-user storage allowance in bytes (PGAS-like, default 1 MB)
   */
  constructor(directory, identities, { allowance = 1_000_000 } = {}) {
    this.dir = directory;
    this.ids = identities;
    this.bulletin = []; // Bulletin-style store: [{ threadId, from, to, env, ts }]
    this.threads = new Set(); // "a conversation exists" = registered thread
    this.balances = new Map(); // CASH ledger
    this.transfers = [];
    this.allowance = allowance;
    this.used = new Map(); // sender -> bytes stored
  }

  faucet(address, amount = 100) {
    const a = address.toLowerCase();
    this.balances.set(a, (this.balances.get(a) || 0) + amount);
    return this.balance(address);
  }

  balance(address) {
    return this.balances.get(address.toLowerCase()) || 0;
  }

  // "Start a conversation" — register the thread (the app's open-chat action).
  startConversation(a, b) {
    const t = threadIdOf(a, b);
    this.threads.add(t);
    return t;
  }

  conversationExists(a, b) {
    return this.threads.has(threadIdOf(a, b));
  }

  // E2EE message into the Bulletin store (ciphertext only — no plaintext stored).
  // Opening a chat auto-registers the thread (as in the app).
  sendMessage(from, to, plaintext) {
    const t = threadIdOf(from, to);
    if (!this.threads.has(t)) this.startConversation(from, to);
    const key = conversationKey(this.ids[from.toLowerCase()], this.ids[to.toLowerCase()], t);
    const env = encrypt(plaintext, key, t);
    const size = Buffer.byteLength(env.ct, 'hex') / 2;
    const used = (this.used.get(from.toLowerCase()) || 0) + size;
    if (used > this.allowance) throw new Error('storage allowance exhausted (PGAS)');
    this.used.set(from.toLowerCase(), used);
    this.bulletin.push({ threadId: t, from, to, env, ts: Date.now() });
    return { threadId: t, env };
  }

  // Recipient-side read: decrypts the inbox (only works for real participants).
  readInbox(address) {
    const me = this.ids[address.toLowerCase()];
    return this.bulletin
      .filter((m) => m.to.toLowerCase() === address.toLowerCase())
      .map((m) => {
        const peer = this.ids[m.from.toLowerCase()];
        const key = conversationKey(me, peer, m.threadId);
        return { from: m.from, threadId: m.threadId, ts: m.ts, text: decrypt(m.env, key) };
      });
  }

  // CASH — GATED: the conversation must already exist (the observed app rule).
  sendCash(from, to, amount) {
    const t = threadIdOf(from, to);
    if (!this.threads.has(t)) {
      throw new Error('CASH transfer rejected: start a conversation first (no existing thread)');
    }
    if (this.balance(from) < amount) throw new Error('insufficient CASH balance');
    const f = from.toLowerCase(), o = to.toLowerCase();
    this.balances.set(f, this.balance(from) - amount);
    this.balances.set(o, this.balance(to) + amount);
    const rec = { threadId: t, from, to, amount, ts: Date.now() };
    this.transfers.push(rec);
    return rec;
  }

  // Bulletin store introspection (what an operator/indexer would see: ciphertext only).
  bulletinView() {
    return this.bulletin.map((m) => ({
      threadId: m.threadId.slice(0, 18) + '…',
      from: m.from.slice(0, 8) + '…',
      to: m.to.slice(0, 8) + '…',
      ciphertextBytes: Buffer.byteLength(m.env.ct, 'hex') / 2,
    }));
  }
}

module.exports = { DevnetChat, threadIdOf };
