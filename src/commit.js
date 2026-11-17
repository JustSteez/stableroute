'use strict';
// Recomputes the circuit's public dataHash from a published snapshot, so anyone can
// check that a proof was made over exactly these pools.
const crypto = require('crypto');
const { buildPoseidon } = require('circomlibjs');

let poseidonP = null;
const N = 8;

function snapshotField(snapshot) {
  const h = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest();
  return BigInt('0x' + h.subarray(0, 31).toString('hex'));
}

const pack = (c) => c
  ? BigInt(1) + 2n * BigInt(c.blue) + 4n * BigInt(c.down) + 8n * BigInt(c.tvl)
    + (1n << 51n) * BigInt(c.base) + (1n << 71n) * BigInt(c.reward) + (1n << 91n) * BigInt(c.mean30)
  : 0n;

async function dataHash(snapshot) {
  if (!poseidonP) poseidonP = buildPoseidon();
  const poseidon = await poseidonP;
  const rows = Array.from({ length: N }, (_, i) => pack(snapshot.candidates[i]));
  return poseidon.F.toString(poseidon([snapshotField(snapshot), ...rows]));
}

module.exports = { dataHash, snapshotField };
