'use strict';
// Groth16 proof that the route decision follows the published policy.
const path = require('path');
const fs = require('fs');
const snarkjs = require('snarkjs');

const DIR = path.join(__dirname, '..', 'circuits');
const WASM = path.join(DIR, 'route_decision.wasm');
const ZKEY = path.join(DIR, 'route_decision_final.zkey');
const VK = JSON.parse(fs.readFileSync(path.join(DIR, 'route_decision_vk.json'), 'utf8'));

async function prove(input) {
  const t = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const verified = await snarkjs.groth16.verify(VK, publicSignals, proof);
  return { proof, publicSignals, verifiedLocally: verified, ms: Date.now() - t };
}

const verify = (publicSignals, proof) => snarkjs.groth16.verify(VK, publicSignals, proof);

module.exports = { prove, verify, VK };
