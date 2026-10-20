// Compile MessageAnchor.sol with solc-js -> build/MessageAnchor.json {abi, bytecode}.
// Run: node compile.js
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const SRC = path.join(__dirname, 'contracts', 'MessageAnchor.sol');
const OUT = path.join(__dirname, 'build');

const source = fs.readFileSync(SRC, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MessageAnchor.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'london', // match the in-process EVM hardfork (no PUSH0/MCOPY)
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
const c = out.contracts['MessageAnchor.sol']['MessageAnchor'];
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'MessageAnchor.json'),
  JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2)
);
console.log('compiled MessageAnchor ->', path.join(OUT, 'MessageAnchor.json'));
console.log('solc', solc.version());
console.log('bytecode bytes:', c.evm.bytecode.object.length / 2);
