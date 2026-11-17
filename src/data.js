'use strict';
// Live yield data from DeFiLlama's public yields API (no key needed).
const { BLUE_CHIP } = require('./policy');

const YIELDS_URL = process.env.YIELDS_URL || 'https://yields.llama.fi/pools';
const LEND_URL = process.env.LEND_URL || 'https://yields.llama.fi/lendBorrow';
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, pools: null };

async function fetchPools() {
  if (process.env.YIELDS_FIXTURE) {
    // offline/testing: load a saved snapshot
    const raw = require('fs').readFileSync(process.env.YIELDS_FIXTURE, 'utf8');
    return { fetchedAt: new Date().toISOString(), pools: JSON.parse(raw).data };
  }
  if (cache.pools && Date.now() - cache.at < CACHE_MS) return { fetchedAt: new Date(cache.at).toISOString(), pools: cache.pools };
  const [r, lb] = await Promise.all([
    fetch(YIELDS_URL, { signal: AbortSignal.timeout(20000) }),
    // /pools reports lending TVL as supply minus borrows; /lendBorrow has total deposits.
    fetch(LEND_URL, { signal: AbortSignal.timeout(20000) }).then((x) => (x.ok ? x.json() : [])).catch(() => []),
  ]);
  if (!r.ok) throw new Error(`DeFiLlama yields API returned ${r.status}`);
  const j = await r.json();
  const supply = new Map((Array.isArray(lb) ? lb : []).map((x) => [x.pool, x.totalSupplyUsd]));
  for (const p of j.data) { const s = supply.get(p.pool); if (s) p.totalSupplyUsd = s; }
  cache = { at: Date.now(), pools: j.data };
  return { fetchedAt: new Date(cache.at).toISOString(), pools: j.data };
}

const bps = (x) => (typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(Math.round(x * 100), 1_000_000) : 0);

// Keep single-asset stablecoin pools on the chosen chains/token, and convert to circuit units.
function normalize(pools, { chains, token }) {
  const chainSet = chains && chains.length ? new Set(chains.map((c) => c.toLowerCase())) : null;
  const tok = (token || 'ANY').toUpperCase();
  const out = [];
  for (const p of pools) {
    if (!p.stablecoin || p.exposure !== 'single' || p.ilRisk !== 'no') continue;
    if (chainSet && !chainSet.has(String(p.chain).toLowerCase())) continue;
    const sym = String(p.symbol || '').toUpperCase();
    if (sym.includes('-')) continue;
    if (tok !== 'ANY' && sym !== tok && sym !== tok + '.E') continue;
    const c = {
      pool: p.pool,
      project: p.project,
      chain: p.chain,
      symbol: sym,
      poolMeta: p.poolMeta || null,
      underlying: (p.underlyingTokens && p.underlyingTokens[0]) || null,
      // Lending pools: DeFiLlama's tvlUsd is supply minus borrows (idle cash). Pool size means total deposits,
      // so use totalSupplyUsd when it is reported.
      tvl: Math.max(0, Math.min(Math.floor(Math.max(p.tvlUsd || 0, p.totalSupplyUsd || 0)), 2 ** 48 - 1)),
      base: bps(p.apyBase),
      reward: bps(p.apyReward),
      mean30: bps(p.apyMean30d),
      blue: BLUE_CHIP.has(p.project) ? 1 : 0,
      down: p.predictions && p.predictions.predictedClass === 'Down' ? 1 : 0,
    };
    if (c.tvl < 1_000_000 || c.base + c.reward === 0) continue;
    out.push(c);
  }
  return out;
}

module.exports = { fetchPools, normalize };
