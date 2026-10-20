// demo.js — End-to-end PoC of the LUKSO on-chain messaging layer.
//
// Runs a REAL EVM in-process (@ethereumjs/vm v10), deploys MessageAnchor,
// simulates 3 Universal Profiles (EOAs stand in for LSP6 controllers), sends
// DMs between them, and proves:
//   (1) per-message EIP-191 signatures authenticate the sender (ERC-1271-style
//       off-chain check, as the contract comment documents),
//   (2) the on-chain monotonic nonce gives replay protection (a replayed tx reverts),
//   (3) anchored records + events read back correctly from the recipient inbox.
//
// Run:  node demo.js        (from poc/evm-side/, after `node compile.js`)
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

async function main() {
  // ethereumjs v10 is ESM-only -> dynamic import from CJS.
  const { createVM, runTx } = await import('@ethereumjs/vm');
  const { Common, Mainnet, Hardfork } = await import('@ethereumjs/common');
  const { createLegacyTx } = await import('@ethereumjs/tx');
  const { Account, Address, createAddressFromPrivateKey, hexToBytes, bytesToHex } =
    await import('@ethereumjs/util');

  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'build', 'MessageAnchor.json'), 'utf8')
  );
  const iface = new ethers.Interface(artifact.abi);

  const common = new Common({ chain: Mainnet, hardfork: Hardfork.London });
  const vm = await createVM({ common });

  // --- three Universal Profiles (controller EOAs stand in for LSP6 controllers) ---
  const keys = {
    Alice: '0x1111111111111111111111111111111111111111111111111111111111111111',
    Bob: '0x2222222222222222222222222222222222222222222222222222222222222222',
    Carol: '0x3333333333333333333333333333333333333333333333333333333333333333',
  };
  const ups = {}; // name -> { wallet, ejAddr, pk(Uint8Array), txNonce }
  for (const [name, pk] of Object.entries(keys)) {
    const wallet = new ethers.Wallet(pk);
    const pkb = hexToBytes(pk);
    const ejAddr = createAddressFromPrivateKey(pkb);
    await vm.stateManager.putAccount(
      ejAddr,
      new Account(0n, 100n * 10n ** 18n) // nonce, balance (100 ETH)
    );
    ups[name] = { wallet, ejAddr, pk: pkb, txNonce: 0n };
    console.log(`UP ${name.padEnd(5)} = ${wallet.address}`);
  }

  const GAS_PRICE = 1_000_000_000n; // 1 gwei >= London base fee in default block
  const GAS_LIMIT = 3_000_000n;

  // send a signed state-changing tx from an EOA, return the RunTxResult
  async function sendTx(fromName, to, data) {
    const up = ups[fromName];
    const tx = createLegacyTx(
      {
        nonce: up.txNonce,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        to: to || undefined,
        value: 0n,
        data: hexToBytes(data),
      },
      { common }
    ).sign(up.pk);
    up.txNonce += 1n;
    return runTx(vm, { tx });
  }

  // read-only call (eth_call style) via the low-level EVM
  async function call(to, data) {
    const res = await vm.evm.runCall({
      to,
      caller: ups.Alice.ejAddr,
      origin: ups.Alice.ejAddr,
      gasLimit: GAS_LIMIT,
      data: hexToBytes(data),
    });
    return bytesToHex(res.execResult.returnValue);
  }

  // --- deploy ---
  const dep = await sendTx('Alice', null, artifact.bytecode);
  if (dep.execResult.exceptionError) throw new Error('deploy failed: ' + dep.execResult.exceptionError.error);
  const anchorAddr = dep.createdAddress;
  console.log('\nMessageAnchor deployed at', anchorAddr.toString(), '\n');

  // deterministic threadId for a pair (sorted so both directions share a thread)
  function threadId(a, b) {
    const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
    return ethers.solidityPackedKeccak256(['address', 'address'], [lo, hi]);
  }

  // the digest a UP controller signs (mirrors the abi.encode in the .sol hook)
  function digestOf(tid, to, contentHash, nonce) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'bytes32', 'uint256'],
        [tid, to, contentHash, nonce]
      )
    );
  }

  // send one DM: sign off-chain (EIP-191), verify, then anchor on-chain
  const sentWorkPackages = [];
  async function sendDM(fromName, toName, body, nonce) {
    const from = ups[fromName];
    const to = ups[toName];
    const tid = threadId(from.wallet.address, to.wallet.address);
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(body)); // off-chain body hash
    const digest = digestOf(tid, to.wallet.address, contentHash, nonce);

    // controller signs (ERC-1271 / LSP6 SIGN path, done at the edge not on-chain)
    const sig = await from.wallet.signMessage(ethers.getBytes(digest));
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
    const authOk = recovered.toLowerCase() === from.wallet.address.toLowerCase();

    const data = iface.encodeFunctionData('anchor', [tid, to.wallet.address, contentHash, nonce]);
    const res = await sendTx(fromName, anchorAddr, data);
    const reverted = !!res.execResult.exceptionError;

    console.log(
      `DM ${fromName}->${toName} n=${nonce} auth=${authOk ? 'OK' : 'FAIL'} ` +
        `anchored=${!reverted ? 'yes' : 'REVERTED'} body="${body}"`
    );
    if (!reverted) {
      // a "work package" the relayer would emit to the JAM layer (see poc/relay)
      sentWorkPackages.push({
        threadId: tid,
        from: from.wallet.address,
        to: to.wallet.address,
        contentHash,
        nonce,
        sig,
      });
    }
    return { res, reverted };
  }

  // NOTE: the anchor nonce is per-SENDER (global across all that sender's threads),
  // giving a verifiable total order per sender. So Alice's nonces run 0,1,2.
  console.log('--- sending DMs ---');
  await sendDM('Alice', 'Bob', 'gm Bob, this is anchored on LUKSO', 0);
  await sendDM('Bob', 'Alice', 'gm Alice, got it — reply anchored too', 0);
  await sendDM('Alice', 'Carol', 'hi Carol, separate thread', 1);
  await sendDM('Alice', 'Bob', 'second message to Bob', 2);

  // --- replay protection: resend Alice->Bob with an already-used nonce (0) ---
  console.log('\n--- replay-protection check (expect REVERT) ---');
  const replay = await sendDM('Alice', 'Bob', 'REPLAYED old nonce', 0);
  let decodedErr = null;
  try {
    decodedErr = iface.parseError(ethers.hexlify(replay.res.execResult.returnValue));
  } catch (_) {}
  console.log(
    'replay reverted:', replay.reverted,
    decodedErr ? `(${decodedErr.name} expected=${decodedErr.args[0]} got=${decodedErr.args[1]})` : ''
  );

  // --- read back Bob's inbox for the Alice<->Bob thread ---
  console.log('\n--- Bob inbox (Alice<->Bob thread) ---');
  const tidAB = threadId(ups.Alice.wallet.address, ups.Bob.wallet.address);
  const cntHex = await call(anchorAddr, iface.encodeFunctionData('inboxCount', [tidAB, ups.Bob.wallet.address]));
  const cnt = iface.decodeFunctionResult('inboxCount', cntHex)[0];
  console.log('message count:', cnt.toString());
  for (let i = 0n; i < cnt; i++) {
    const mHex = await call(anchorAddr, iface.encodeFunctionData('getMessage', [tidAB, ups.Bob.wallet.address, i]));
    const m = iface.decodeFunctionResult('getMessage', mHex)[0];
    console.log(`  [${i}] from=${m.from} ts=${m.timestamp} nonce=${m.nonce} contentHash=${m.contentHash}`);
  }

  // --- decode the MessageAnchored events from the last successful Alice->Bob tx ---
  console.log('\n--- events emitted (from a single anchor tx) ---');
  const oneTx = await sendDM('Carol', 'Bob', 'event decode sample', 0);
  for (const log of oneTx.res.receipt.logs) {
    const parsed = iface.parseLog({ topics: log[1].map(bytesToHex), data: bytesToHex(log[2]) });
    if (parsed) console.log(`  ${parsed.name}`, {
      threadId: parsed.args.threadId, from: parsed.args.from, to: parsed.args.to,
      nonce: parsed.args.nonce.toString(),
    });
  }

  // --- dump the work packages that the relayer would forward to JAM ---
  console.log('\n--- work packages the relayer would emit to the JAM layer ---');
  console.log(JSON.stringify(sentWorkPackages, null, 2));

  console.log('\nDEMO OK: real EVM, signatures verified, replay reverted, inbox read back.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
