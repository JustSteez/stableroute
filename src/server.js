'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { route } = require('./router');
const { prove, verify } = require('./prover');
const kurier = require('./kurier');
const nl = require('./nl');
const commit = require('./commit');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const MAX_BODY = 256 * 1024;

// recent snapshots + proofs, so anyone can fetch and re-check them
const store = new Map();
const remember = (k, v) => { store.set(k, v); if (store.size > 500) store.delete(store.keys().next().value); };

function send(res, status, obj, sign = false) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': body.length };
  if (sign && SECRET) headers['x-agent-games-signature'] = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Full agent run: route -> prove -> (optionally) submit to zkVerify.
async function run(params, { withProof = true } = {}) {
  const r = await route(params);
  const out = { agent: 'StableRoute', ...r };
  delete out.circuitInput;
  if (withProof) {
    const p = await prove(r.circuitInput);
    const expected = await commit.dataHash(r.snapshot);
    out.proof = {
      system: 'groth16/bn128', verifiedLocally: p.verifiedLocally, provingMs: p.ms,
      dataHash: p.publicSignals[2], dataHashMatchesSnapshot: p.publicSignals[2] === expected,
      publicSignalOrder: ['eligibleMask', 'chosenScore', 'dataHash', 'amount', 'minTvl', 'capBps', 'minBaseShareBps', 'maxSpikePct', 'requireBlue', 'allowDown', 'hasPick', 'pick'],
      publicSignals: p.publicSignals, proof: p.proof,
    };
    try {
      out.zkverify = await kurier.submit(p);
    } catch (e) {
      out.zkverify = { submitted: false, error: e.message };
    }
  }
  remember(r.snapshotHash, { snapshot: r.snapshot, proof: out.proof, zkverify: out.zkverify, at: new Date().toISOString() });
  return out;
}

async function handleAgent(req, res, raw) {
  if (!SECRET) return send(res, 503, { ok: false, error: 'AGENT_GAMES_HMAC_SECRET not configured' });
  const sig = String(req.headers['x-agent-games-signature'] || '').replace(/^sha256=/, '');
  const want = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    return send(res, 401, { ok: false, error: 'bad signature' });
  }
  let task = {};
  try { task = JSON.parse(raw.toString('utf8') || '{}'); } catch { return send(res, 400, { ok: false, error: 'invalid JSON' }, true); }
  const type = String(task.type || task.kind || '').toLowerCase();
  if (task.preflight === true || ['preflight', 'ping', 'health', 'handshake', 'verify'].includes(type) || Object.keys(task).length === 0) {
    return send(res, 200, { ok: true, protocolVersion: 'v1' }, true);
  }
  const input = task.input || task;
  try {
    const params = input.text || input.prompt ? (await nl.parse(input.text || input.prompt)).params : input;
    const out = await run(params);
    return send(res, 200, { ok: true, protocolVersion: 'v1', taskId: task.task_id || task.taskId || null, result: out }, true);
  } catch (e) {
    return send(res, 200, { ok: false, protocolVersion: 'v1', taskId: task.task_id || task.taskId || null, error: e.message }, true);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { ok: true, agent: 'StableRoute', zkverify: kurier.enabled() ? 'kurier' : 'local-proof-only', llmParser: !!process.env.ANTHROPIC_API_KEY, hmac: !!SECRET });
    }
    if (p === '/route' || p === '/ask') {
      let params;
      if (req.method === 'GET') params = Object.fromEntries(url.searchParams);
      else { const raw = await readBody(req); params = JSON.parse(raw.toString('utf8') || '{}'); }
      let parsed = null;
      if (p === '/ask' || params.text) {
        parsed = await nl.parse(params.text || '');
        params = { ...parsed.params, ...(params.wallet ? { wallet: params.wallet } : {}) };
        if (!params.amount) return send(res, 400, { ok: false, error: 'Could not find an amount in that request, e.g. "Put $5,000 USDC somewhere safe on Base"', understood: parsed.params });
      }
      const out = await run(params, { withProof: params.proof !== 'false' && params.proof !== false });
      if (parsed) out.understood = parsed;
      return send(res, 200, { ok: true, ...out });
    }
    if (req.method === 'GET' && p.startsWith('/snapshot/')) {
      const v = store.get(p.slice('/snapshot/'.length));
      return v ? send(res, 200, v) : send(res, 404, { ok: false, error: 'unknown snapshot (kept in memory for recent runs only)' });
    }
    if (req.method === 'GET' && p.startsWith('/proof-status/')) {
      return send(res, 200, await kurier.status(p.slice('/proof-status/'.length)));
    }
    if (req.method === 'POST' && p === '/verify') {
      const { proof, publicSignals } = JSON.parse((await readBody(req)).toString('utf8'));
      return send(res, 200, { valid: await verify(publicSignals, proof) });
    }
    if (req.method === 'GET' && (p === '/agent' || p === '/api/agent')) {
      return send(res, 200, { ok: true, agent: 'StableRoute', protocolVersion: 'v1', hmac: !!SECRET, note: 'Agent Games endpoint. Send HMAC-signed POST requests here.' });
    }
    if (req.method === 'POST' && (p === '/agent' || p === '/api/agent')) {
      return handleAgent(req, res, await readBody(req));
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`StableRoute listening on :${PORT} (zkVerify: ${kurier.enabled() ? 'on' : 'local proofs only'})`));
}
// Default export is the server itself (Vercel's Node runtime serves it directly);
// named exports stay for the tests.
module.exports = server;
module.exports.server = server;
module.exports.run = run;
