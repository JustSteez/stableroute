'use strict';
// Submits proofs to zkVerify through Kurier (https://kurier.xyz). Optional: only runs when KURIER_API_KEY is set.
const { VK } = require('./prover');

const BASE = () => process.env.KURIER_API_URL || 'https://api-testnet.kurier.xyz/api/v1';
const OPTS = { library: 'snarkjs', curve: 'bn128' };
let vkHash = process.env.KURIER_VK_HASH || null;

const enabled = () => !!process.env.KURIER_API_KEY;

async function call(method, p, body) {
  const r = await fetch(`${BASE()}${p}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`Kurier ${p.split('/')[1]} ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

async function registerVk() {
  if (vkHash) return vkHash;
  try {
    const j = await call('POST', `/register-vk/${process.env.KURIER_API_KEY}`, { proofType: 'groth16', proofOptions: OPTS, vk: VK });
    vkHash = j.vkHash || j.meta?.vkHash || null;
  } catch (e) {
    // already registered: Kurier returns the existing hash in the error body
    const m = /0x[0-9a-fA-F]{64}/.exec(e.message);
    if (m) vkHash = m[0]; else console.warn('[kurier] register-vk failed:', e.message);
  }
  return vkHash;
}

async function submit({ proof, publicSignals }) {
  if (!enabled()) return { submitted: false, reason: 'KURIER_API_KEY not set' };
  const hash = await registerVk();
  const body = hash
    ? { proofType: 'groth16', vkRegistered: true, proofOptions: OPTS, proofData: { proof, publicSignals, vk: hash } }
    : { proofType: 'groth16', vkRegistered: false, proofOptions: OPTS, proofData: { proof, publicSignals, vk: VK } };
  const j = await call('POST', `/submit-proof/${process.env.KURIER_API_KEY}`, body);
  return { submitted: true, jobId: j.jobId, optimisticVerify: j.optimisticVerify, vkHash: hash };
}

async function status(jobId) {
  if (!enabled()) throw new Error('KURIER_API_KEY not set');
  return call('GET', `/job-status/${process.env.KURIER_API_KEY}/${encodeURIComponent(jobId)}`);
}

module.exports = { submit, status, enabled };
