// deploy-ups.js — create two REAL Universal Profiles (alice, bob) on LUKSO mainnet
// via the official LSP23 Linked Contracts Factory, each owned by its own funded
// controller EOA. Idempotent via lab-ups/state.json.
//
// Flow:
//   1. fund each controller EOA from Z's EOA (gas money)
//   2. each controller deploys UP + LSP6 KeyManager through LSP23 (ERC1167 proxies)
//   3. fund each UP with FUND_UP LYX
//
// Keys (gitignored, workspace root):
//   ../../../../.z-lukso-key.json     (Z EOA, funder)
//   ../../../../.lab-alice-key.json   (alice controller)
//   ../../../../.lab-bob-key.json     (bob controller)
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';

// --- canonical LUKSO infra (verified on-chain 2026-10-21, v0.14.0 impls) ---
const LSP23_FACTORY = '0x2300000A84D25dF63081feAa37ba6b62C4c89a30';
const UP_POST_DEPLOY_INIT = '0x000000000066093407b6704B89793beFfD0D8F00';
const UP_INIT = '0x3024D38EA2434BA6635003Dc1BDC0daB5882ED4F';
const KM_INIT = '0x2Fe3AeD98684E7351aD2D408A43cE09a738BF8a4';

// --- LSP6 / ERC725Y data keys ---
const ALL_PERMISSIONS = '0x00000000000000000000000000000000000000000000000000000000007f3f7f';
const AP_ARRAY_LENGTH = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3'; // AddressPermissions[]
const AP_ARRAY_INDEX_PREFIX = '0xdf30dba06db6a30e65354d9a64c6098600000000000000000000000000000000'; // AddressPermissions[] index prefix (16 bytes)
const AP_PERMISSIONS_PREFIX = '0x4b80742de2bf82acb3630000'; // AddressPermissions:Permissions:<address>

// --- funding amounts ---
const FUND_CTRL = ethers.parseUnits('0.02', 'ether'); // gas money per controller
const FUND_UP = ethers.parseUnits('0.1', 'ether');    // working balance per UP

const KEYDIR = '/home/bk/.openclaw/workspace';
const STATEFILE = path.join(__dirname, 'state.json');

// --- minimal ABIs ---
const UP_INIT_ABI = ['function initialize(address initialOwner)'];
const KM_INIT_ABI = ['function initialize(address target)'];
const FACTORY_ABI = [
  'function computeERC1167Addresses((bytes32 salt,uint256 fundingAmount,address implementationContract,bytes initializationCalldata) primary,(uint256 fundingAmount,address implementationContract,bytes initializationCalldata,bool addPrimaryContractAddress,bytes extraInitializationParams) secondary,address postDeploymentModule,bytes postDeploymentCalldata) view returns (address,address)',
  'function deployERC1167Proxies((bytes32 salt,uint256 fundingAmount,address implementationContract,bytes initializationCalldata) primary,(uint256 fundingAmount,address implementationContract,bytes initializationCalldata,bool addPrimaryContractAddress,bytes extraInitializationParams) secondary,address postDeploymentModule,bytes postDeploymentCalldata) payable returns (address,address)',
];

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); }
function link(kind, id) { return `${EXPLORER}/${kind}/${id}`; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      const net = await p.getNetwork();
      if (net.chainId !== 42n) throw new Error(`wrong chain ${net.chainId}`);
      console.log('RPC:', rpc);
      return p;
    } catch (e) { console.error('rpc fail', rpc, String(e).split('\n')[0]); err = e; }
  }
  throw err || new Error('all RPCs failed');
}

async function feeOf(p) {
  const f = await p.getFeeData();
  const base = f.gasPrice || f.maxFeePerGas || ethers.parseUnits('2', 'gwei');
  return base * 120n / 100n; // +20% buffer
}

async function send(wallet, p, txBase, label) {
  const tx = { ...txBase, nonce: await p.getTransactionCount(wallet.address, 'pending'), gasPrice: await feeOf(p) };
  const t = await wallet.sendTransaction(tx);
  console.log(`  ${label}: ${t.hash}`);
  const r = await p.waitForTransaction(t.hash, 2, 180_000);
  if (!r || r.status !== 1) throw new Error(`${label} failed: ${t.hash}`);
  return { tx: t, rcpt: r };
}

// Build the encodedSetData (LSP6 permissions) exactly like @lukso/lsp-utils deployUniversalProfile
function buildSetData(controllerAddr) {
  const ctrl = controllerAddr.toLowerCase().substring(2);
  const keys = [
    AP_ARRAY_LENGTH,
    AP_ARRAY_INDEX_PREFIX, // index 0
    AP_PERMISSIONS_PREFIX + ctrl,
  ];
  const values = [
    ethers.toBeHex(1, 16),   // array length = 1
    controllerAddr,          // AddressPermissions[0] = controller
    ALL_PERMISSIONS,         // its permissions
  ];
  return new ethers.AbiCoder().encode(['bytes32[]', 'bytes[]'], [keys, values]);
}

async function deployUP(provider, ctrlWallet, label, state) {
  const upIface = new ethers.Interface(UP_INIT_ABI);
  const kmIface = new ethers.Interface(KM_INIT_ABI);
  const factory = new ethers.Contract(LSP23_FACTORY, FACTORY_ABI, ctrlWallet);

  const salt = state.salt || ethers.hexlify(ethers.randomBytes(32));
  state.salt = salt;

  const primary = {
    salt,
    fundingAmount: 0,
    implementationContract: UP_INIT,
    initializationCalldata: upIface.encodeFunctionData('initialize', [UP_POST_DEPLOY_INIT]),
  };
  const secondary = {
    fundingAmount: 0,
    implementationContract: KM_INIT,
    initializationCalldata: kmIface.getFunction('initialize').selector,
    addPrimaryContractAddress: true,
    extraInitializationParams: '0x',
  };
  const setData = buildSetData(ctrlWallet.address);

  const [upAddr, kmAddr] = await factory.computeERC1167Addresses(primary, secondary, UP_POST_DEPLOY_INIT, setData);
  console.log(`  computed ${label} UP:`, upAddr, '| KM:', kmAddr);
  state.upAddress = upAddr;
  state.kmAddress = kmAddr;

  if (!state.deployTx) {
    const data = factory.interface.encodeFunctionData('deployERC1167Proxies', [primary, secondary, UP_POST_DEPLOY_INIT, setData]);
    const { tx } = await send(ctrlWallet, provider, { to: LSP23_FACTORY, data, gasLimit: 1_200_000n }, `deploy ${label} UP+KM`);
    state.deployTx = tx.hash;
  } else {
    console.log(`  ${label} already deployed:`, state.deployTx);
  }
  // verify code exists
  const code = await provider.getCode(upAddr);
  if (!code || code === '0x') throw new Error(`${label} UP has no code at ${upAddr}`);
  return state;
}

async function main() {
  const provider = await connect();
  const zKey = load(path.join(KEYDIR, '.z-lukso-key.json'));
  const aKey = load(path.join(KEYDIR, '.lab-alice-key.json'));
  const bKey = load(path.join(KEYDIR, '.lab-bob-key.json'));
  const z = new ethers.Wallet(zKey.privateKey, provider);
  const alice = new ethers.Wallet(aKey.privateKey, provider);
  const bob = new ethers.Wallet(bKey.privateKey, provider);

  const state = load(STATEFILE);
  state.alice = state.alice || { controller: alice.address };
  state.bob = state.bob || { controller: bob.address };

  console.log('Z funder:', z.address, ethers.formatEther(await provider.getBalance(z.address)), 'LYX');
  console.log('alice ctrl:', alice.address, '| bob ctrl:', bob.address);

  // --- 1. fund controllers ---
  for (const [name, ctrl] of [['alice', alice], ['bob', bob]]) {
    const bal = await provider.getBalance(ctrl.address);
    if (bal < FUND_CTRL) {
      await send(z, provider, { to: ctrl.address, value: FUND_CTRL - bal, gasLimit: 21000n }, `fund ${name} ctrl`);
    } else {
      console.log(`  ${name} ctrl already funded:`, ethers.formatEther(bal), 'LYX');
    }
  }

  // --- 2. deploy UPs ---
  console.log('\n-- deploy alice UP --');
  state.alice = await deployUP(provider, alice, 'alice', state.alice);
  saveState(state);
  console.log('\n-- deploy bob UP --');
  state.bob = await deployUP(provider, bob, 'bob', state.bob);
  saveState(state);

  // --- 3. fund the UPs ---
  for (const [name, info] of [['alice', state.alice], ['bob', state.bob]]) {
    const bal = await provider.getBalance(info.upAddress);
    if (bal < FUND_UP) {
      await send(z, provider, { to: info.upAddress, value: FUND_UP - bal, gasLimit: 100000n }, `fund ${name} UP`);
      info.fundedUp = true;
    } else {
      console.log(`  ${name} UP already funded:`, ethers.formatEther(bal), 'LYX');
    }
  }
  saveState(state);

  console.log('\n=== UPs READY ON LUKSO MAINNET ===');
  console.log('alice UP:', state.alice.upAddress, '\n  ' + link('address', state.alice.upAddress));
  console.log('  controller:', alice.address, '| KM:', state.alice.kmAddress, '| deploy:', link('tx', state.alice.deployTx));
  console.log('bob   UP:', state.bob.upAddress, '\n  ' + link('address', state.bob.upAddress));
  console.log('  controller:', bob.address, '| KM:', state.bob.kmAddress, '| deploy:', link('tx', state.bob.deployTx));
  console.log('\nZ remaining:', ethers.formatEther(await provider.getBalance(z.address)), 'LYX');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
