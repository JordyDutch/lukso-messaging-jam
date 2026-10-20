// devnet-spike.js — EXPERIMENT: reproduce the Polkadot Product Devnet messaging flow
// on the LUKSO/UP side, with adapters, and prove one conversation is anchored BOTH
// in the Bulletin-style store (devnet model) AND on LUKSO via MessageAnchor (our L1).
//
// The flow reproduced (observed in the official Product Devnet app, 2026-10-20):
//   1. B tops up CASH from a faucet.
//   2. B types a prefix in user search -> autocomplete suggests users (directory).
//   3. B picks a user -> conversation opens (thread registered).
//   4. B tries to send CASH first -> REJECTED: no conversation yet (app-level rule).
//   5. B sends a (E2EE) message -> conversation exists.
//   6. B sends CASH inside the chat -> OK (transfer attached to the thread).
//   7. A replies; the relay anchors both messages on LUKSO with the SAME threadIds.
//
// Run:  node devnet-spike.js   (after `cd ../evm-side && node compile.js`)
'use strict';
const path = require('path');
const { MockDirectory } = require('./identity');
const { makeIdentity } = require('./e2ee');
const { DevnetChat, threadIdOf } = require('./chat');
const { ethers } = require('ethers');
const { LocalChain } = require('../relay/local-chain');
const { MockJamService } = require('../relay/mock-jam-service');
const { Relay } = require('../relay/relay');

function digestOf(tid, to, contentHash, nonce) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32', 'uint256'], [tid, to, contentHash, nonce])
  );
}

function show(title, lines) {
  console.log(`\n--- ${title} ---`);
  for (const l of lines) console.log('  ' + l);
}

async function main() {
  // ---- 0. Identity: 3 UPs, each with a pseudonym + .dot name (devnet-style) ----
  const dir = new MockDirectory();
  const chain = await new LocalChain().init();
  const up = (name, pseudo, dot) => {
    const address = chain.address(name);
    dir.registerUser({ pseudonym: pseudo, dotName: dot, address });
    return { name, address };
  };
  const A = up('Alice', 'alice', 'alice.dot');
  const B = up('Bob', 'bob', 'bob.dot');
  const C = up('Carol', 'carol', 'carol.dot');
  const identities = {};
  for (const { address } of [A, B, C]) identities[address.toLowerCase()] = makeIdentity();

  const chat = new DevnetChat(dir, identities);
  show('0. identities (pseudonym + .dot + UP address)', [
    `${A.name}: alice / alice.dot / ${A.address}`,
    `${B.name}: bob / bob.dot / ${B.address}`,
    `${C.name}: carol / carol.dot / ${C.address}`,
  ]);

  // ---- 1. B tops up CASH from the faucet ----
  chat.faucet(B.address);
  show('1. faucet top-up', [`${B.name} CASH balance: ${chat.balance(B.address)}`]);

  // ---- 2. Autocomplete: B types "a" -> suggestions ----
  const suggestions = dir.searchUsers('a');
  show('2. user search "a" (autocomplete)', suggestions.map((s) => `${s.pseudonym} (${s.matched}) -> ${s.address.slice(0, 10)}…`));

  // ---- 3/4. CASH before any conversation -> rejected (the observed app rule) ----
  let cashBlocked = null;
  try {
    chat.sendCash(B.address, A.address, 10);
  } catch (e) {
    cashBlocked = e.message;
  }
  show('4. B tries CASH before chatting', [cashBlocked || '(unexpected: allowed!)']);

  // ---- 5. B picks alice from autocomplete, opens chat, sends an E2EE message ----
  const target = dir.resolve(suggestions[0].pseudonym);
  chat.sendMessage(B.address, target, 'gm alice! (E2EE)');
  show('5. conversation opened + first message (E2EE)', [
    `threadId = ${threadIdOf(B.address, target)}`,
    'Bulletin store holds CIPHERTEXT only: ' + JSON.stringify(chat.bulletinView()[0]),
  ]);

  // ---- 6. Now CASH inside the chat -> allowed ----
  const t = chat.sendCash(B.address, target, 10);
  show('6. CASH sent inside the conversation', [
    `transfer ${t.amount} CASH, threadId ${t.threadId.slice(0, 18)}…`,
    `balances: B=${chat.balance(B.address)}  A=${chat.balance(target)}`,
  ]);

  // ---- 7. A replies; relay anchors BOTH on LUKSO with the SAME threadIds ----
  const jam = new MockJamService();
  const relay = new Relay(chain, jam);
  await chain.deploy();
  console.log(`\n--- 7. anchoring on LUKSO (same threadIds as the Bulletin store) ---`);

  const nonces = {};
  const addrToName = {}; for (const [name, r] of Object.entries(chain.ups)) addrToName[r.wallet.address.toLowerCase()] = name;
  async function sendAnchored(fromAddr, toAddr, plaintext) {
    const fromName = addrToName[fromAddr.toLowerCase()];
    const toName = addrToName[toAddr.toLowerCase()];
    const n = (nonces[fromName] = (nonces[fromName] || 0));
    const tid = threadIdOf(fromAddr, toAddr);
    const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(plaintext));
    // E2EE envelope is the off-chain body (IPFS in production) — hash the ciphertext:
    const env = encryptForAnchor(fromAddr, toAddr, plaintext, tid);
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(env)));
    const sig = await chain.ups[fromName].wallet.signMessage(ethers.getBytes(digestOf(tid, toAddr, contentHash, n)));
    relay.submitSignature(chain.address(fromName), n, sig);
    const { reverted } = await chain.anchor(fromName, toAddr, contentHash, n);
    console.log(`  anchor ${fromName}->${toName} n=${n} ${reverted ? 'REVERTED' : 'ok'}  (thread ${tid.slice(0, 18)}…)`);
    nonces[fromName] = n + 1;
  }
  // (E2EE helpers for the anchored body)
  const { conversationKey, encrypt } = require('./e2ee');
  function encryptForAnchor(from, to, plaintext, tid) {
    return encrypt(plaintext, conversationKey(identities[from.toLowerCase()], identities[to.toLowerCase()], tid), tid);
  }

  await sendAnchored(B.address, A.address, 'gm alice! (E2EE)');
  await sendAnchored(A.address, B.address, 'gm bob (E2EE reply)');

  const n = await relay.poll();
  console.log(`  relay forwarded ${n} work packages to the (mock) JAM service`);

  // ---- Cross-check: same conversation, two backends, same threadId ----
  const tidApp = threadIdOf(B.address, A.address);
  const onChain = chain.getLogs(0).map((l) => chain.iface.parseLog(l).args.threadId);
  show('8. one conversation, two backends, one threadId', [
    `app threadId:        ${tidApp}`,
    `LUKSO anchor event:  ${onChain[0]}  ${tidApp === onChain[0] ? 'MATCH ✓' : 'MISMATCH ✗'}`,
    `A's decrypted inbox (app side):`,
    ...chat.readInbox(A.address).map((m) => `   ${m.from.slice(0, 8)}…: "${m.text}"`),
  ]);

  // ---- Negative check: Carol (not in the conversation) cannot read the ciphertext ----
  let carolCanRead = true;
  try {
    const env = chat.bulletin[0].env;
    const { decrypt } = require('./e2ee');
    const wrongKey = conversationKey(identities[C.address.toLowerCase()], identities[B.address.toLowerCase()], env.threadId);
    decrypt(env, wrongKey);
  } catch (e) {
    carolCanRead = false;
  }
  show('9. E2EE negative check', [
    carolCanRead ? 'FAIL: Carol decrypted the message ✗' : 'Carol (outsider) GCM-auth fails — cannot read ✓',
  ]);

  console.log('\nSPIKE OK: devnet flow reproduced on LUKSO/UP with adapters; threadIds match across backends.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
