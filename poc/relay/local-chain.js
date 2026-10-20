// local-chain.js — a minimal "local node" stand-in for the PoC.
//
// Wraps the in-process @ethereumjs/vm (the same engine demo.js uses) and exposes
// a tiny JSON-RPC-like surface the relayer consumes:
//   - deploy() / anchor(fromName, to, contentHash, nonce)  -> state changes
//   - getLogs(fromBlock)                                    -> MessageAnchored events
//
// The relayer is written ONLY against getLogs(), so swapping this for a real
// ethers.JsonRpcProvider pointed at a LUKSO RPC is a drop-in change (see relay.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ARTIFACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'evm-side', 'build', 'MessageAnchor.json'), 'utf8')
);

const KEYS = {
  Alice: '0x1111111111111111111111111111111111111111111111111111111111111111',
  Bob: '0x2222222222222222222222222222222222222222222222222222222222222222',
  Carol: '0x3333333333333333333333333333333333333333333333333333333333333333',
};

class LocalChain {
  constructor() {
    this.iface = new ethers.Interface(ARTIFACT.abi);
    this.logs = []; // { blockNumber, topics[], data } — mimics eth_getLogs output
    this.block = 0;
    this.ups = {};
  }

  async init() {
    const { createVM, runTx } = await import('@ethereumjs/vm');
    const { Common, Mainnet, Hardfork } = await import('@ethereumjs/common');
    const { createLegacyTx } = await import('@ethereumjs/tx');
    const { Account, createAddressFromPrivateKey, hexToBytes, bytesToHex } = await import('@ethereumjs/util');
    this._lib = { runTx, createLegacyTx, hexToBytes, bytesToHex };

    this.common = new Common({ chain: Mainnet, hardfork: Hardfork.London });
    this.vm = await createVM({ common: this.common });

    for (const [name, pk] of Object.entries(KEYS)) {
      const wallet = new ethers.Wallet(pk);
      const pkb = hexToBytes(pk);
      const addr = createAddressFromPrivateKey(pkb);
      await this.vm.stateManager.putAccount(addr, new Account(0n, 100n * 10n ** 18n));
      this.ups[name] = { wallet, addr, pk: pkb, txNonce: 0n };
    }
    return this;
  }

  address(name) {
    return this.ups[name].wallet.address;
  }

  async _send(fromName, to, dataHex) {
    const { runTx, createLegacyTx, hexToBytes, bytesToHex } = this._lib;
    const up = this.ups[fromName];
    const tx = createLegacyTx(
      { nonce: up.txNonce, gasPrice: 1_000_000_000n, gasLimit: 3_000_000n, to: to || undefined, data: hexToBytes(dataHex) },
      { common: this.common }
    ).sign(up.pk);
    up.txNonce += 1n;
    const res = await runTx(this.vm, { tx });
    this.block += 1;
    // collect logs in eth_getLogs shape
    for (const log of res.receipt.logs) {
      this.logs.push({ blockNumber: this.block, topics: log[1].map(bytesToHex), data: bytesToHex(log[2]) });
    }
    return res;
  }

  async deploy() {
    const res = await this._send('Alice', null, ARTIFACT.bytecode);
    this.anchorAddr = res.createdAddress;
    return this.anchorAddr.toString();
  }

  // Anchor a message on-chain (controller already signed off-chain; see relay sig check).
  async anchor(fromName, toAddr, contentHash, nonce) {
    const data = this.iface.encodeFunctionData('anchor', [
      this._threadId(this.address(fromName), toAddr),
      toAddr,
      contentHash,
      nonce,
    ]);
    const res = await this._send(fromName, this.anchorAddr, data);
    return { reverted: !!res.execResult.exceptionError };
  }

  _threadId(a, b) {
    const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
    return ethers.solidityPackedKeccak256(['address', 'address'], [lo, hi]);
  }

  // eth_getLogs stand-in: return MessageAnchored logs at/after fromBlock.
  getLogs(fromBlock = 0) {
    const topic0 = this.iface.getEvent('MessageAnchored').topicHash;
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.topics[0] === topic0);
  }
}

module.exports = { LocalChain, KEYS, ARTIFACT };
