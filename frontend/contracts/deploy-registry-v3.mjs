// deploy-registry-v3.mjs — compile + deploy RegistryV3 to LUKSO mainnet (chain 42).
//
//   node deploy-registry-v3.mjs            -> compile only (dry run, no spend)
//   BROADCAST=1 node deploy-registry-v3.mjs -> deploy for real
//
// Idempotent: records the deployed address in registry-v3-state.json; a second
// run with that file present just prints the address, never redeploys.
// Key: workspace root .z-lukso-key.json (gitignored). Uses poc/node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '..', '..', 'poc', 'noop.js'));
const solc = require('solc');
const { ethers } = require('ethers');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.execution.mainnet.lukso.network';
const KEYFILE = path.join(__dirname, '..', '..', '..', '.z-lukso-key.json');
const STATEFILE = path.join(__dirname, 'registry-v3-state.json');
const SRC = path.join(__dirname, 'RegistryV3.sol');

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2));
const link = (k, id) => `${EXPLORER}/${k}/${id}`;

function compile() {
  const source = fs.readFileSync(SRC, 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'RegistryV3.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['RegistryV3.sol']['RegistryV3'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      if ((await p.getNetwork()).chainId !== 42n) throw new Error('wrong chain');
      return p;
    } catch (e) { console.error('rpc fail', rpc, String(e).split('\n')[0]); err = e; }
  }
  throw err;
}

async function main() {
  const art = compile();
  console.log('compiled RegistryV3: bytecode', (art.bytecode.length - 2) / 2, 'bytes');

  const state = loadState();
  if (state.address) { console.log('already deployed @', state.address, '\n  ' + link('address', state.address)); return; }

  if (process.env.BROADCAST !== '1') { console.log('\n[dry run] compile OK. set BROADCAST=1 to deploy.'); return; }

  const key = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
  const provider = await connect();
  const wallet = new ethers.Wallet(key.privateKey, provider);
  console.log('deployer:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('balance:', ethers.formatEther(bal), 'LYX');

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const fee = await provider.getFeeData();
  const gasPrice = (fee.gasPrice || ethers.parseUnits('2', 'gwei')) * 110n / 100n;
  const c = await factory.deploy({ gasPrice });
  console.log('deploy tx:', c.deploymentTransaction().hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  state.address = addr;
  state.deployTx = c.deploymentTransaction().hash;
  state.chainId = 42;
  saveState(state);
  console.log('\n=== RegistryV3 DEPLOYED ===');
  console.log('address:', addr, '\n  ' + link('address', addr));
  console.log('tx:     ', c.deploymentTransaction().hash, '\n  ' + link('tx', c.deploymentTransaction().hash));
  console.log('\nnext: set VITE_REGISTRY_ADDRESS=' + addr + ' in frontend/.env.local');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
