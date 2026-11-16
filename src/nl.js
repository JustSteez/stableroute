'use strict';
// Turns a plain-English request into router parameters.
// The LLM (optional) only parses intent; it never makes the routing decision.

const CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'];

function parseRules(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const out = {};
  const m = /\$?\s*([\d][\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/.exec(t);
  if (m) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const s = m[2];
    if (s === 'k' || s === 'thousand') n *= 1e3;
    if (s === 'm' || s === 'million') n *= 1e6;
    out.amount = n;
  }
  if (/\busdt\b|tether/.test(t)) out.token = 'USDT';
  else if (/\bdai\b/.test(t)) out.token = 'DAI';
  else if (/\busdc\b/.test(t)) out.token = 'USDC';
  else if (/any stable|any token/.test(t)) out.token = 'ANY';
  const chains = CHAINS.filter((c) => t.includes(c) || (c === 'ethereum' && /\b(eth mainnet|mainnet|l1)\b/.test(t)) || (c === 'arbitrum' && /\barb\b/.test(t)));
  if (chains.length) out.chains = chains;
  if (/degen|aggressive|high risk|max(imum)? yield|risky/.test(t)) out.risk = 'high';
  else if (/balanced|medium|moderate/.test(t)) out.risk = 'medium';
  else if (/safe|low risk|conservative|careful|blue.?chip/.test(t)) out.risk = 'low';
  const w = /0x[0-9a-fA-F]{40}/.exec(text);
  if (w) out.wallet = w[0];
  return out;
}

async function parseLLM(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 200,
      system: 'Extract a stablecoin deposit request as JSON only, no prose: {"amount": number USD, "token": "USDC"|"USDT"|"DAI"|"ANY", "chains": array of "base"|"ethereum"|"arbitrum"|"optimism"|"polygon", "risk": "low"|"medium"|"high", "wallet": "0x..." or null}. Omit fields the user did not imply.',
      messages: [{ role: 'user', content: String(text).slice(0, 1000) }],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const s = j.content?.[0]?.text || '';
  const m = /\{[\s\S]*\}/.exec(s);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function parse(text) {
  const rules = parseRules(text);
  let llm = null;
  try { llm = await parseLLM(text); } catch { /* fall back to rules */ }
  const merged = { ...rules, ...(llm || {}) };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  return { params: merged, parser: llm ? 'llm' : 'rules' };
}

module.exports = { parse, parseRules };
