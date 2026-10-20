// identity.js — the "identity" primitive adapter.
//
// Polkadot Product Devnet (observed 2026-10-20 in the official app) exposes identity as:
//   - a registered "personhood pseudonym" (cryptographic context), and
//   - a `.dot` name (DotNS) the app's directory can be searched by.
// Observed UX: type a prefix in the app's user search -> the app suggests matching
// users (autocomplete over the registered directory).
//
// LUKSO/UP equivalent: the UP address itself IS the identity; human names come from
// ENS (or any resolver). This module defines the shared adapter interface plus a
// MockDirectory that reproduces the devnet's autocomplete so the chat PoC can run
// without any chain. Swap in a real resolver (ENS on LUKSO testnet, or a probe of
// the devnet's directory endpoint) WITHOUT touching the chat code — that is the point
// of the adapter (see docs/ADAPTERS.md).
'use strict';

class MockDirectory {
  constructor() {
    this.users = new Map(); // pseudonym(lowercased) -> { pseudonym, dotName, address }
  }

  // registerUser({ pseudonym, dotName?, address }) -> user record
  registerUser({ pseudonym, dotName = null, address }) {
    const p = pseudonym.toLowerCase();
    if (this.users.has(p)) throw new Error(`pseudonym already taken: ${pseudonym}`);
    const rec = { pseudonym, dotName: dotName ? dotName.toLowerCase() : null, address };
    this.users.set(p, rec);
    return rec;
  }

  // Autocomplete: prefix match over pseudonyms AND .dot names (the observed app
  // behavior — typing "a" suggests all users starting with a). Ranked: pseudonym
  // prefix first, then .dot prefix.
  searchUsers(prefix, { limit = 10 } = {}) {
    const q = String(prefix).toLowerCase();
    if (!q) return [];
    const out = [];
    for (const u of this.users.values()) {
      if (u.pseudonym.startsWith(q)) out.push({ ...u, matched: 'pseudonym' });
      else if (u.dotName && u.dotName.startsWith(q)) out.push({ ...u, matched: 'dotName' });
    }
    out.sort((a, b) =>
      a.matched === b.matched ? a.pseudonym.localeCompare(b.pseudonym) : a.matched === 'pseudonym' ? -1 : 1
    );
    return out.slice(0, limit);
  }

  // resolve('alice' | 'alice.dot' | <address>) -> address
  resolve(name) {
    const n = String(name).toLowerCase();
    if (this.users.has(n)) return this.users.get(n).address;
    for (const u of this.users.values()) if (u.dotName === n) return u.address;
    if (/^0x[0-9a-f]{40}$/.test(n)) return n; // pass-through for raw addresses
    throw new Error(`no user for name: ${name}`);
  }
}

// Adapter interface (what a real implementation must provide):
//   registerUser({ pseudonym, dotName, address })
//   searchUsers(prefix, { limit }) -> [{ pseudonym, dotName, address, matched }]
//   resolve(name) -> address
// Real candidates:
//   - ENS on LUKSO (testnet/mainnet): resolve via provider, index names off-chain
//   - DotNS (.dot): resolve via Polkadot People chain / DNS-like lookups
//   - Product Devnet directory: probe the app's endpoint (testnet, "expect chaos")
module.exports = { MockDirectory };
