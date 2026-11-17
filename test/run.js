'use strict';
// End-to-end tests against the offline fixture. Run: npm test
process.env.YIELDS_FIXTURE = require('path').join(__dirname, 'fixture.json');
process.env.AGENT_GAMES_HMAC_SECRET = 'test-secret';
delete process.env.KURIER_API_KEY;
const crypto = require('crypto');
const assert = require('assert');
const { server } = require('../src/server');
const { parseRules } = require('../src/nl');
const { prove } = require('../src/prover');
const { route } = require('../src/router');

const sign = (b) => crypto.createHmac('sha256', 'test-secret').update(b).digest('hex');
let base;
const post = async (p, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: r.status, sig: r.headers.get('x-agent-games-signature'), text: await r.text() };
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok -', name); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  await t('health', async () => {
    const j = await (await fetch(base + '/health')).json();
    assert.equal(j.ok, true);
  });
  await t('low risk on Base picks a blue-chip pool and rejects the traps', async () => {
    const j = JSON.parse((await post('/route', { amount: 10000, risk: 'low', chains: 'base' })).text);
    assert.equal(j.decision, 'ROUTE');
    assert.equal(j.pick.project, 'morpho-blue');
    const farm = j.shortlist.find((s) => s.project === 'yieldfarmx');
    assert.equal(farm.passed, false);
    assert.equal(j.proof.verifiedLocally, true);
    assert.equal(j.proof.dataHashMatchesSnapshot, true);
    assert.equal(j.proof.publicSignals.length, 12); // zkVerify Groth16 limit is 16
  });
  await t('emission farm and APY spike are rejected even at high risk', async () => {
    const j = JSON.parse((await post('/route', { amount: 5000, risk: 'high', chains: 'base' })).text);
    for (const p of ['yieldfarmx', 'newlend']) assert.equal(j.shortlist.find((s) => s.project === p).passed, false, p);
  });
  await t('oversized deposit gets NO_SAFE_ROUTE with a valid proof', async () => {
    const j = JSON.parse((await post('/route', { amount: 20e6, risk: 'low', chains: 'base' })).text);
    assert.equal(j.decision, 'NO_SAFE_ROUTE');
    assert.equal(j.proof.verifiedLocally, true);
  });
  await t('Aave pick drafts approve + supply', async () => {
    const j = JSON.parse((await post('/route', { amount: 1000, risk: 'low', chains: 'arbitrum', wallet: '0x1111111111111111111111111111111111111111' })).text);
    assert.equal(j.pick.project, 'aave-v3');
    assert.deepEqual(j.pick.deposit.steps.map((s) => s.data.slice(0, 10)), ['0x095ea7b3', '0x617ba037']);
  });
  await t('plain-English request', async () => {
    const j = JSON.parse((await post('/ask', { text: 'put $10k usdc somewhere safe on base' })).text);
    assert.equal(j.understood.params.amount, 10000);
    assert.equal(j.policy.risk, 'low');
    assert.deepEqual(parseRules('degen 2.5m usdt on arbitrum'), { amount: 2500000, token: 'USDT', chains: ['arbitrum'], risk: 'high' });
  });
  await t('a lying decision cannot be proven', async () => {
    const r = await route({ amount: 10000, risk: 'low', chains: 'base' });
    const bad = { ...r.circuitInput, pick: r.shortlist.findIndex((s) => s.project === 'yieldfarmx') };
    await assert.rejects(prove(bad));
    const worse = { ...r.circuitInput, pick: r.shortlist.findIndex((s) => s.project === 'aave-v3') }; // passes but not the best
    await assert.rejects(prove(worse));
  });
  await t('agent endpoint: unsigned request rejected', async () => {
    assert.equal((await post('/agent', { type: 'preflight' })).status, 401);
  });
  await t('agent endpoint: signed preflight answered and signed', async () => {
    const body = JSON.stringify({ type: 'preflight' });
    const r = await fetch(base + '/agent', { method: 'POST', headers: { 'x-agent-games-signature': sign(body) }, body });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, protocolVersion: 'v1' });
    assert.equal(r.headers.get('x-agent-games-signature'), sign(Buffer.from(text)));
  });
  await t('agent endpoint: signed task routed', async () => {
    const body = JSON.stringify({ type: 'stableroute.route.v1', task_id: 't1', input: { text: '$2000 USDC low risk on ethereum' } });
    const r = await fetch(base + '/agent', { method: 'POST', headers: { 'x-agent-games-signature': sign(body) }, body });
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.taskId, 't1'); assert.equal(j.result.decision, 'ROUTE');
  });

  console.log(`\n${n} tests passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
