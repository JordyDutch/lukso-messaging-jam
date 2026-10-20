// pipeline.js — full end-to-end PoC: LUKSO EVM -> relayer -> (mock) JAM service.
//
// Run:  node pipeline.js        (from poc/relay/, after `node ../evm-side/compile.js`)
//
// Shows the complete flow from docs/DESIGN.md:
//   client signs (ERC-1271/LSP6)  ->  anchor() on LUKSO  ->  relay reads event
//   ->  relay forwards work package  ->  JAM.refine (verify sig)  ->  JAM.accumulate
//   ->  recipient inbox in the JAM service.
'use strict';
const { ethers } = require('ethers');
const { LocalChain } = require('./local-chain');
const { MockJamService } = require('./mock-jam-service');
const { Relay } = require('./relay');

function digestOf(tid, to, contentHash, nonce) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes32', 'uint256'],
      [tid, to, contentHash, nonce]
    )
  );
}

async function main() {
  const chain = await new LocalChain().init();
  const addr = await chain.deploy();
  console.log('LUKSO (local) MessageAnchor @', addr);
  console.log('UPs:', ['Alice', 'Bob', 'Carol'].map((n) => `${n}=${chain.address(n)}`).join('  '), '\n');

  const jam = new MockJamService();
  const relay = new Relay(chain, jam);

  // Client-side: sign the message (controller key / LSP6 SIGN), hand sig to relay,
  // then anchor metadata on-chain. threadId/nonce mirror the contract.
  async function clientSend(fromName, toName, body, nonce) {
    const from = chain.ups[fromName].wallet;
    const toAddr = chain.address(toName);
    const tid = chain._threadId(from.address, toAddr);
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(body));
    const sig = await from.signMessage(ethers.getBytes(digestOf(tid, toAddr, contentHash, nonce)));
    relay.submitSignature(from.address, nonce, sig);
    const { reverted } = await chain.anchor(fromName, toAddr, contentHash, nonce);
    console.log(`anchor ${fromName}->${toName} n=${nonce} ${reverted ? 'REVERTED' : 'ok'}  "${body}"`);
  }

  console.log('--- clients anchor messages on LUKSO ---');
  await clientSend('Alice', 'Bob', 'gm Bob (via JAM relay)', 0);
  await clientSend('Carol', 'Bob', 'Bob, Carol here', 0);
  await clientSend('Alice', 'Bob', 'second to Bob', 1);
  await clientSend('Bob', 'Alice', 'reply to Alice', 0);

  console.log('\n--- relay polls LUKSO and forwards to the JAM service ---');
  const n = await relay.poll();
  console.log(`\nrelay forwarded ${n} work packages into the JAM service`);

  // Demonstrate the relay is replay-safe even if it double-polls the same logs.
  console.log('\n--- relay double-poll (cursor advanced; nothing new) ---');
  const n2 = await relay.poll();
  console.log('forwarded on second poll:', n2);

  console.log('\n--- JAM service inboxes (what the UP mini-app would read) ---');
  for (const name of ['Alice', 'Bob', 'Carol']) {
    const inbox = jam.readInbox(chain.address(name));
    console.log(`${name} (${chain.address(name)}): ${inbox.length} message(s)`);
    for (const m of inbox) console.log(`   from=${m.from} n=${m.nonce} hash=${m.contentHash.slice(0, 18)}…`);
  }

  console.log('\nPIPELINE OK: EVM anchor -> relay -> JAM refine/accumulate -> inbox.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
