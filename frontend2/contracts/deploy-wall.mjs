// deploy-wall.mjs — compile + deploy Wall.sol to LUKSO mainnet from Z's EOA.
// Idempotent via wall-state.json. Run: node deploy-wall.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// reuse the poc's installed ethers + solc
const { ethers } = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/ethers');
const solc = require('/home/bk/.openclaw/workspace/lukso-jam-messaging/poc/node_modules/solc');

const RPCS = ['https://42.rpc.thirdweb.com', 'https://rpc.mainnet.lukso.network'];
const EXPLORER = 'https://explorer.lukso.network';
const KEYDIR = '/home/bk/.openclaw/workspace';
const STATE = path.join(__dirname, 'wall-state.json');

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }

async function connect() {
  let err;
  for (const rpc of RPCS) {
    try { const p = new ethers.JsonRpcProvider(rpc); if ((await p.getNetwork()).chainId !== 42n) throw new Error('chain'); console.log('RPC:', rpc); return p; } catch (e) { err = e; }
  }
  throw err;
}
function compile() {
  const src = fs.readFileSync(path.join(__dirname, 'Wall.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Wall.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['Wall.sol']['Wall'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function main() {
  const provider = await connect();
  const state = load(STATE);
  if (state.address) { console.log('Wall already deployed:', state.address, '\n' + EXPLORER + '/address/' + state.address); return; }

  const z = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  console.log('Z:', z.address, ethers.formatEther(await provider.getBalance(z.address)), 'LYX');

  const { abi, bytecode } = compile();
  const fee = await provider.getFeeData();
  const gasPrice = (fee.gasPrice || ethers.parseUnits('2', 'gwei')) * 120n / 100n;
  const factory = new ethers.ContractFactory(abi, bytecode, z);
  const c = await factory.deploy({ gasLimit: 900_000n, gasPrice });
  console.log('deploy tx:', c.deploymentTransaction().hash);
  await c.waitForDeployment();
  const address = await c.getAddress();
  fs.writeFileSync(STATE, JSON.stringify({ address, deployTx: c.deploymentTransaction().hash, chainId: 42, abi }, null, 2));
  console.log('Wall @', address, '\n' + EXPLORER + '/address/' + address);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
