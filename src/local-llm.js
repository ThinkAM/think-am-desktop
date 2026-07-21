'use strict';

// Minimal, dependency-free LLM client for the local auto-fix loop (main
// process only). Reuses whatever BYOK provider the user already configured
// in the wizard's Step 3 — no separate credentials, no new product surface.
// Mirrors the shape (not the code) of the server's BackendInferenceEngine:
// one function per provider, all returning { ok, text, error }.

const crypto = require('node:crypto');

// Field names deliberately match wizard.js's buildRequest() output exactly
// (llmProvider, openaiApiKey, bedrockAccessKeyId, ...) so the same object
// built for the server request can be passed straight through to the local
// fixer with no translation layer to keep in sync.
function hasProvider(llmConfig) {
  return !!(llmConfig && llmConfig.llmProvider);
}

async function callLlm(llmConfig, systemPrompt, userPrompt) {
  if (!llmConfig || !llmConfig.llmProvider) {
    return { ok: false, text: null, error: 'Nenhum provider de IA configurado.' };
  }
  try {
    if (llmConfig.llmProvider === 'anthropic') return await callAnthropic(llmConfig, systemPrompt, userPrompt);
    if (llmConfig.llmProvider === 'bedrock') return await callBedrock(llmConfig, systemPrompt, userPrompt);
    return await callOpenAiCompatible(llmConfig, systemPrompt, userPrompt);
  } catch (err) {
    return { ok: false, text: null, error: String((err && err.message) || err) };
  }
}

async function callOpenAiCompatible(cfg, systemPrompt, userPrompt) {
  const base = String(cfg.openaiBaseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, text: null, error: 'Base URL não configurada.' };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.openaiApiKey ? { Authorization: `Bearer ${cfg.openaiApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.openaiModel || '',
      temperature: 0.1,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, text: null, error: `HTTP ${res.status}: ${body ? JSON.stringify(body).slice(0, 300) : res.statusText}` };
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return text ? { ok: true, text, error: null } : { ok: false, text: null, error: 'Resposta vazia do modelo.' };
}

async function callAnthropic(cfg, systemPrompt, userPrompt) {
  if (!cfg.anthropicApiKey) return { ok: false, text: null, error: 'Anthropic API key não configurada.' };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel || 'claude-opus-4-8',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, text: null, error: `HTTP ${res.status}: ${body ? JSON.stringify(body).slice(0, 300) : res.statusText}` };
  const text = (body && body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text ? { ok: true, text, error: null } : { ok: false, text: null, error: 'Resposta vazia do modelo.' };
}

// --- AWS SigV4, hand-rolled (no @aws-sdk dependency in this zero-deps app) ---

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function encodeSegment(segment) {
  // Percent-encode a single path segment per SigV4 rules (unreserved chars
  // A-Za-z0-9-_.~ are left alone); applied per-segment so the "/" separators
  // in the path are never touched.
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function signSigV4({ method, host, path, region, service, accessKeyId, secretAccessKey, sessionToken, body }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = path.split('/').map((seg) => (seg ? encodeSegment(seg) : seg)).join('/');
  const payloadHash = sha256Hex(body);

  const headerEntries = [
    ['host', host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
    ...(sessionToken ? [['x-amz-security-token', sessionToken]] : []),
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');

  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      host,
      'content-type': 'application/json',
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
      authorization,
    },
    canonicalUri,
  };
}

async function callBedrock(cfg, systemPrompt, userPrompt) {
  if (!cfg.bedrockAccessKeyId || !cfg.bedrockSecretAccessKey) return { ok: false, text: null, error: 'Credenciais AWS não configuradas.' };
  const region = (cfg.bedrockRegion || 'us-east-1').trim();
  const model = (cfg.bedrockModel || 'anthropic.claude-opus-4-8').trim();
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${model}/invoke`;
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const { headers, canonicalUri } = signSigV4({
    method: 'POST',
    host,
    path,
    region,
    service: 'bedrock',
    accessKeyId: cfg.bedrockAccessKeyId,
    secretAccessKey: cfg.bedrockSecretAccessKey,
    body,
  });

  const res = await fetch(`https://${host}${canonicalUri}`, { method: 'POST', headers, body });
  const respBody = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, text: null, error: `HTTP ${res.status}: ${respBody ? JSON.stringify(respBody).slice(0, 300) : res.statusText}` };
  const text = (respBody && respBody.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text ? { ok: true, text, error: null } : { ok: false, text: null, error: 'Resposta vazia do modelo.' };
}

// The fix prompt asks for raw file content, but models routinely wrap it in
// a fenced code block anyway — strip that if present, otherwise trust the
// response as-is (mirrors the server's _extract_code_block pattern).
function extractCode(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

module.exports = { hasProvider, callLlm, extractCode };
