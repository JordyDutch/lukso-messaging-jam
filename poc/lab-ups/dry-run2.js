'use strict';
const { ethers } = require('../node_modules/ethers');
const fs = require('fs');
const LSP23_FACTORY = '0x2300000A84D25dF63081feAa37ba6b62C4c89a30';
const UP_POST_DEPLOY_INIT = '0x000000000066093407b6704B89793beFfD0D8F00';
const UP_INIT = '0x3024D38EA2434BA6635003Dc1BDC0daB5882ED4F';
const KM_INIT = '0x2Fe3AeD98684E7351aD2D408A43cE09a738BF8a4';
const ALL_PERMISSIONS = '0x00000000000000000000000000000000000000000000000000000000007f3f7f';
const AP_ARRAY_LENGTH = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const AP_ARRAY_INDEX_PREFIX = '0xdf30dba06db6a30e65354d9a64c6098600000000000000000000000000000000';
const AP_PERMISSIONS_PREFIX = '0x4b80742de2bf82acb3630000';
const FACTORY_ABI = ['function computeERC1167Addresses((bytes32 salt,uint256 fundingAmount,address implementationContract,bytes initializationCalldata) primary,(uint256 fundingAmount,address implementationContract,bool addPrimaryContractAddress,bytes initializationCalldata,bytes extraInitializationParams) secondary,address postDeploymentModule,bytes postDeploymentCalldata) view returns (address,address)'];
const upIface = new ethers.Interface(['function initialize(address initialOwner)']);
const kmIface = new ethers.Interface(['function initialize(address target)']);

(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.mainnet.lukso.network');
  const aKey = JSON.parse(fs.readFileSync('/home/bk/.openclaw/workspace/.lab-alice-key.json'));
  const ctrl = aKey.address;
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const primary = { salt, fundingAmount: 0, implementationContract: UP_INIT, initializationCalldata: upIface.encodeFunctionData('initialize', [UP_POST_DEPLOY_INIT]) };
  const secondary = { fundingAmount: 0, implementationContract: KM_INIT, addPrimaryContractAddress: true, initializationCalldata: kmIface.getFunction('initialize').selector, extraInitializationParams: '0x' };
  const ctrlLc = ctrl.toLowerCase().substring(2);
  const keys = [AP_ARRAY_LENGTH, AP_ARRAY_INDEX_PREFIX, AP_PERMISSIONS_PREFIX + ctrlLc];
  const values = [ethers.toBeHex(1, 16), ctrl, ALL_PERMISSIONS];
  const setData = new ethers.AbiCoder().encode(['bytes32[]', 'bytes[]'], [keys, values]);
  const f = new ethers.Contract(LSP23_FACTORY, FACTORY_ABI, p);
  const [up, km] = await f.computeERC1167Addresses(primary, secondary, UP_POST_DEPLOY_INIT, setData);
  console.log('DRY RUN OK');
  console.log('  predicted alice UP:', up, '| KM:', km);
  const data = new ethers.Interface(['function deployERC1167Proxies((bytes32,uint256,address,bytes),(uint256,address,bool,bytes,bytes),address,bytes) payable returns (address,address)']).encodeFunctionData('deployERC1167Proxies', [[salt, 0, UP_INIT, primary.initializationCalldata], [0, KM_INIT, true, secondary.initializationCalldata, '0x'], UP_POST_DEPLOY_INIT, setData]);
  try {
    const g = await p.estimateGas({ from: ctrl, to: LSP23_FACTORY, data });
    const fee = await p.getFeeData();
    console.log('  est gas:', g.toString(), '~cost:', ethers.formatEther(g * (fee.gasPrice || 0n)), 'LYX');
  } catch (e) {
    console.log('  gas estimate skipped (pre-fund):', String(e).split('\n')[0]);
  }
})().catch((e) => { console.error('DRY RUN FAIL', String(e).split('\n')[0]); process.exit(1); });
