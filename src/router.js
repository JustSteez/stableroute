'use strict';
const crypto = require('crypto');
const { policyFor, score, check, checkMap, fmt } = require('./policy');
const { fetchPools, normalize } = require('./data');
const { draftDeposit } = require('./txdraft');

const N = 8;              // circuit width
const PASS_SLOTS = 4;     // best policy-passing pools in the shortlist
// remaining slots go to the highest-yield pools that FAILED, so the proof also shows what was turned down

const DEFAULT_CHAINS = ['Base', 'Ethereum', 'Arbitrum'];

function validate(q) {
  const amount = Number(q.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number of USD');
  if (amount > 1e12) throw new Error('amount too large');
  const risk = String(q.risk || 'low').toLowerCase();
  const token = String(q.token || 'USDC').toUpperCase();
  let chains = q.chains || q.chain || DEFAULT_CHAINS;
  if (typeof chains === 'string') chains = chains.split(',').map((s) => s.trim()).filter(Boolean);
  chains = chains.map((c) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase());
  const wallet = q.wallet && /^0x[0-9a-fA-F]{40}$/.test(q.wallet) ? q.wallet : null;
  return { amount, risk, token, chains, wallet };
}

function shortlist(cands, policy) {
  const ranked = cands
    .map((c) => ({ ...c, score: score(c), fails: check(c, policy) }))
    .sort((a, b) => b.score - a.score || b.tvl - a.tvl || a.pool.localeCompare(b.pool));
  const pass = ranked.filter((c) => c.fails.length === 0);
  const fail = ranked.filter((c) => c.fails.length > 0);
  const nPass = Math.min(pass.length, Math.max(PASS_SLOTS, N - fail.length));
  const list = [...pass.slice(0, nPass), ...fail.slice(0, N - nPass)];
  // fixed order (score desc) so the snapshot is canonical
  list.sort((a, b) => b.score - a.score || b.tvl - a.tvl || a.pool.localeCompare(b.pool));
  return { list, totalConsidered: ranked.length, totalPassing: pass.length };
}

function snapshotHash(snapshot) {
  const h = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest();
  return { hex: '0x' + h.toString('hex'), field: BigInt('0x' + h.subarray(0, 31).toString('hex')) };
}

function circuitInput(list, policy, hash, pickIdx) {
  const pad = { tvl: 0, base: 0, reward: 0, mean30: 0, blue: 0, down: 0 };
  const rows = Array.from({ length: N }, (_, i) => list[i] || pad);
  return {
    snapshotHash: hash.field.toString(),
    present: rows.map((_, i) => (list[i] ? 1 : 0)),
    tvl: rows.map((r) => r.tvl), base: rows.map((r) => r.base), reward: rows.map((r) => r.reward),
    mean30: rows.map((r) => r.mean30), blue: rows.map((r) => r.blue), down: rows.map((r) => r.down),
    amount: policy.amount, minTvl: policy.minTvl, capBps: policy.capBps,
    minBaseShareBps: policy.minBaseShareBps, maxSpikePct: policy.maxSpikePct,
    requireBlue: policy.requireBlue, allowDown: policy.allowDown,
    hasPick: pickIdx >= 0 ? 1 : 0, pick: pickIdx >= 0 ? pickIdx : 0,
  };
}

const apy = (b) => (b / 100).toFixed(2) + '%';

function explain(pick, policy, sl, amount) {
  if (!pick) {
    return `No pool passed the ${policy.label.toLowerCase()} checks out of ${sl.totalConsidered} candidates. Try a higher risk level, another chain, or a smaller amount.`;
  }
  const yearly = (amount * (pick.base + pick.reward)) / 10000;
  return `Best ${policy.label.toLowerCase()} option: ${pick.project} ${pick.symbol} on ${pick.chain} at ${apy(pick.base + pick.reward)} APY ` +
    `(${apy(pick.base)} organic${pick.reward ? ', ' + apy(pick.reward) + ' in token rewards' : ''}), with $${fmt(pick.tvl)} in the pool. ` +
    `About $${yearly.toFixed(2)} a year on $${amount.toLocaleString('en-US')}, if the rate holds. ` +
    `${sl.totalPassing} of ${sl.totalConsidered} pools passed the checks.`;
}

async function route(query) {
  const q = validate(query);
  const policy = policyFor(q.risk, q.amount);
  const { fetchedAt, pools } = await fetchPools();
  const cands = normalize(pools, q);
  const sl = shortlist(cands, policy);

  let pickIdx = -1;
  sl.list.forEach((c, i) => { if (c.fails.length === 0 && (pickIdx < 0 || c.score > sl.list[pickIdx].score)) pickIdx = i; });
  const pick = pickIdx >= 0 ? sl.list[pickIdx] : null;

  const snapshot = {
    v: 1, source: 'DeFiLlama yields API', fetchedAt,
    query: { amount: q.amount, risk: q.risk, token: q.token, chains: q.chains },
    policy: { minTvl: policy.minTvl, capBps: policy.capBps, minBaseShareBps: policy.minBaseShareBps, maxSpikePct: policy.maxSpikePct, requireBlue: policy.requireBlue, allowDown: policy.allowDown, amount: policy.amount },
    candidates: sl.list.map((c) => ({ pool: c.pool, project: c.project, chain: c.chain, symbol: c.symbol, tvl: c.tvl, base: c.base, reward: c.reward, mean30: c.mean30, blue: c.blue, down: c.down })),
  };
  const hash = snapshotHash(snapshot);

  return {
    decision: pick ? 'ROUTE' : 'NO_SAFE_ROUTE',
    summary: explain(pick, policy, sl, q.amount),
    pick: pick && {
      project: pick.project, chain: pick.chain, symbol: pick.symbol, poolMeta: pick.poolMeta,
      apy: (pick.base + pick.reward) / 100, apyBase: pick.base / 100, apyReward: pick.reward / 100,
      apyMean30d: pick.mean30 / 100, tvlUsd: pick.tvl, pool: pick.pool,
      estYearlyUsd: Math.round((q.amount * (pick.base + pick.reward)) / 100) / 100,
      deposit: draftDeposit(pick, q.amount, q.wallet),
    },
    shortlist: sl.list.map((c, i) => ({
      slot: i, project: c.project, chain: c.chain, symbol: c.symbol, apy: (c.base + c.reward) / 100,
      apyBase: c.base / 100, apyReward: c.reward / 100, tvlUsd: c.tvl, score: c.score,
      apyMean30d: c.mean30 / 100, blueChip: !!c.blue, predictedDown: !!c.down, checks: checkMap(c, policy),
      passed: c.fails.length === 0, reasons: c.fails, picked: i === pickIdx,
    })),
    stats: { considered: sl.totalConsidered, passing: sl.totalPassing },
    policy: { risk: q.risk, label: policy.label, ...snapshot.policy },
    snapshot, snapshotHash: hash.hex,
    circuitInput: circuitInput(sl.list, policy, hash, pickIdx),
  };
}

module.exports = { route, validate, shortlist, circuitInput, snapshotHash, N };
