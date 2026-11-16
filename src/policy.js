'use strict';
// Risk policy. These numbers are the exact public inputs of the circuit,
// so the JS rules below and circuits/route_decision.circom must stay in lockstep.

const TIERS = {
  low: {
    label: 'Low risk',
    minTvl: 50_000_000,      // pool must hold at least $50M
    capBps: 100,             // your deposit <= 1% of the pool
    minBaseShareBps: 9000,   // >= 90% of APY must be organic (not token emissions)
    maxSpikePct: 150,        // current APY <= 1.5x its 30-day average
    requireBlue: 1,          // blue-chip protocols only
    allowDown: 0,            // skip pools DeFiLlama predicts will fall
  },
  medium: {
    label: 'Medium risk',
    minTvl: 10_000_000,
    capBps: 200,
    minBaseShareBps: 7000,
    maxSpikePct: 200,
    requireBlue: 0,
    allowDown: 0,
  },
  high: {
    label: 'High risk',
    minTvl: 1_000_000,
    capBps: 500,
    minBaseShareBps: 3000,
    maxSpikePct: 250,
    requireBlue: 0,
    allowDown: 1,
  },
};

// DeFiLlama project slugs treated as blue-chip (long track record, audited, large TVL).
const BLUE_CHIP = new Set([
  'aave-v3', 'compound-v3', 'morpho-blue', 'morpho-v1', 'sparklend', 'spark-savings',
  'sky-lending', 'fluid-lending', 'euler-v2', 'maple',
]);

function policyFor(risk, amount) {
  const t = TIERS[risk];
  if (!t) throw new Error(`unknown risk level "${risk}" (use low, medium or high)`);
  return { risk, ...t, amount: Math.floor(amount) };
}

// Integer score, identical to the circuit: organic APY counts double, emissions count once.
const score = (c) => 2 * c.base + c.reward;

// Mirrors the circuit checks one by one, returning human-readable reasons.
function check(c, p) {
  const fails = [];
  if (c.tvl < p.minTvl) fails.push(`pool too small ($${fmt(c.tvl)} < $${fmt(p.minTvl)})`);
  if (p.amount * 10000 > c.tvl * p.capBps)
    fails.push(`your deposit would be over ${p.capBps / 100}% of the pool`);
  if (c.base * 10000 < p.minBaseShareBps * (c.base + c.reward))
    fails.push(`only ${pct(c.base, c.base + c.reward)} of the yield is organic; the rest is token rewards`);
  if ((c.base + c.reward) * 100 > p.maxSpikePct * c.mean30)
    fails.push(c.mean30 === 0
      ? 'no 30-day APY history'
      : `APY spiked to ${(c.base + c.reward) / 100}% vs a 30-day average of ${c.mean30 / 100}%`);
  if (p.requireBlue && !c.blue) fails.push('not a blue-chip protocol');
  if (!p.allowDown && c.down) fails.push('APY predicted to fall');
  return fails;
}

const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n);
const pct = (a, b) => (b === 0 ? '0%' : Math.round((a / b) * 100) + '%');

module.exports = { TIERS, BLUE_CHIP, policyFor, score, check, fmt };
