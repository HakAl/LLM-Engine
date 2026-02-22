/**
 * Probe each provider's raw HTTP response to see what data points
 * they actually return (headers, SSE shape, usage, finish_reason, etc.)
 *
 * Usage:  node scripts/probe-providers.mjs
 */

import { readFileSync } from 'fs';

// Load .env
const envText = readFileSync('.env', 'utf8').replace(/\r/g, '');
for (const line of envText.split('\n')) {
  const idx = line.indexOf('=');
  if (idx < 1 || line.startsWith('#')) continue;
  const key = line.slice(0, idx).trim();
  const val = line.slice(idx + 1).trim();
  if (val) process.env[key] = val;
}

// Debug: show which keys were loaded
console.log('Loaded keys:');
for (const k of ['GROQ_API_KEY','CEREBRAS_API_KEY','SAMBANOVA_API_KEY','GITHUB_MODELS_API_KEY','GEMINI_API_KEY']) {
  const v = process.env[k];
  console.log(`  ${k}: ${v ? v.slice(0, 10) + '...' : 'MISSING'}`);
}

const PROVIDERS = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    auth: `Bearer ${process.env.GROQ_API_KEY}`,
    model: 'llama-3.1-8b-instant',
  },
  {
    name: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    auth: `Bearer ${process.env.CEREBRAS_API_KEY}`,
    model: 'llama-3.1-8b',
  },
  {
    name: 'SambaNova',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    auth: `Bearer ${process.env.SAMBANOVA_API_KEY}`,
    model: 'Meta-Llama-3.1-8B-Instruct',
  },
  {
    name: 'GitHub Models',
    url: 'https://models.github.ai/inference/chat/completions',
    auth: `Bearer ${process.env.GITHUB_MODELS_API_KEY}`,
    model: 'openai/gpt-4o-mini',
  },
  {
    name: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    auth: `Bearer ${process.env.GEMINI_API_KEY}`,
    model: 'gemini-2.5-flash-lite',
  },
];

const prompt = [{ role: 'user', content: 'Say hello in exactly 3 words.' }];

async function probeStreaming(provider) {
  console.log('\n' + '='.repeat(70));
  console.log(`${provider.name} — STREAMING (model: ${provider.model})`);
  console.log('='.repeat(70));

  if (!provider.auth || provider.auth === 'Bearer ' || provider.auth === 'Bearer undefined') {
    console.log('  SKIPPED — no API key\n');
    return;
  }

  try {
    const resp = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: provider.auth,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: prompt,
        max_tokens: 30,
        stream: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    console.log(`\n  HTTP ${resp.status}`);

    if (!resp.ok) {
      const errBody = await resp.text();
      console.log(`\n  ERROR BODY:\n  ${errBody.slice(0, 500)}`);
      return;
    }

    // --- Headers (focus on rate-limit related) ---
    console.log('\n  --- Rate-Limit Headers ---');
    const interestingPrefixes = ['x-ratelimit', 'retry-after', 'x-request', 'x-remaining'];
    let foundRateHeaders = false;
    for (const [k, v] of resp.headers.entries()) {
      if (interestingPrefixes.some((p) => k.toLowerCase().startsWith(p))) {
        console.log(`  ${k}: ${v}`);
        foundRateHeaders = true;
      }
    }
    if (!foundRateHeaders) console.log('  (none)');

    // --- All headers for reference ---
    console.log('\n  --- All Headers ---');
    for (const [k, v] of resp.headers.entries()) {
      console.log(`  ${k}: ${v}`);
    }

    // --- SSE body ---
    const body = await resp.text();
    const events = body.split('\n\n').filter((e) => e.startsWith('data: '));

    console.log(`\n  --- SSE Events (${events.length} total) ---`);

    // Show first event fully parsed
    if (events.length > 0) {
      const first = events[0].replace('data: ', '');
      console.log('\n  First event (raw):');
      console.log(`  ${first}`);
      if (first !== '[DONE]') {
        try {
          const parsed = JSON.parse(first);
          console.log('\n  First event (parsed keys):');
          console.log(`  ${JSON.stringify(Object.keys(parsed))}`);
          if (parsed.choices?.[0]) {
            console.log(`  choices[0] keys: ${JSON.stringify(Object.keys(parsed.choices[0]))}`);
            if (parsed.choices[0].delta) {
              console.log(`  delta keys: ${JSON.stringify(Object.keys(parsed.choices[0].delta))}`);
            }
          }
          if (parsed.usage) {
            console.log(`  usage: ${JSON.stringify(parsed.usage)}`);
          }
        } catch {}
      }
    }

    // Show last non-[DONE] event (often has usage/finish_reason)
    const lastDataEvents = events.filter((e) => e !== 'data: [DONE]');
    if (lastDataEvents.length > 1) {
      const last = lastDataEvents[lastDataEvents.length - 1].replace('data: ', '');
      console.log('\n  Last content event (raw):');
      console.log(`  ${last}`);
      try {
        const parsed = JSON.parse(last);
        if (parsed.choices?.[0]) {
          console.log(`  finish_reason: ${JSON.stringify(parsed.choices[0].finish_reason)}`);
        }
        if (parsed.usage) {
          console.log(`  usage: ${JSON.stringify(parsed.usage)}`);
        }
      } catch {}
    }

    // Check if [DONE] sentinel is present
    const hasDone = events.some((e) => e === 'data: [DONE]');
    console.log(`\n  Has [DONE] sentinel: ${hasDone}`);

    // Check for usage in ANY event
    let usageFound = null;
    for (const e of events) {
      const data = e.replace('data: ', '');
      if (data === '[DONE]') continue;
      try {
        const p = JSON.parse(data);
        if (p.usage) { usageFound = p.usage; break; }
      } catch {}
    }
    console.log(`  Usage in stream: ${usageFound ? JSON.stringify(usageFound) : 'NOT PROVIDED'}`);

  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}

// --- Models endpoint probe ---

const MODEL_ENDPOINTS = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/models',
    auth: `Bearer ${process.env.GROQ_API_KEY}`,
  },
  {
    name: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/models',
    auth: `Bearer ${process.env.CEREBRAS_API_KEY}`,
  },
  {
    name: 'SambaNova',
    url: 'https://api.sambanova.ai/v1/models',
    auth: `Bearer ${process.env.SAMBANOVA_API_KEY}`,
  },
  {
    name: 'GitHub Models',
    url: 'https://models.github.ai/inference/models',
    auth: `Bearer ${process.env.GITHUB_MODELS_API_KEY}`,
  },
  {
    name: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    auth: `Bearer ${process.env.GEMINI_API_KEY}`,
  },
];

async function probeModels(endpoint) {
  console.log('\n' + '='.repeat(70));
  console.log(`${endpoint.name} — GET /models`);
  console.log('='.repeat(70));

  if (!endpoint.auth || endpoint.auth === 'Bearer ' || endpoint.auth === 'Bearer undefined') {
    console.log('  SKIPPED — no API key\n');
    return;
  }

  try {
    const resp = await fetch(endpoint.url, {
      method: 'GET',
      headers: { Authorization: endpoint.auth },
      signal: AbortSignal.timeout(10_000),
    });

    console.log(`  HTTP ${resp.status}`);

    if (!resp.ok) {
      const errBody = await resp.text();
      console.log(`  ERROR: ${errBody.slice(0, 300)}`);
      return;
    }

    const json = await resp.json();
    const topKeys = Object.keys(json);
    console.log(`  Top-level keys: ${JSON.stringify(topKeys)}`);

    const data = json.data ?? json.models ?? [];
    console.log(`  Model count: ${data.length}`);

    // Show first 3 model entries (keys + id)
    for (let i = 0; i < Math.min(3, data.length); i++) {
      const m = data[i];
      console.log(`  [${i}] keys: ${JSON.stringify(Object.keys(m))}`);
      console.log(`      id: ${m.id}`);
      if (m.context_window) console.log(`      context_window: ${m.context_window}`);
    }
    if (data.length > 3) console.log(`  ... and ${data.length - 3} more`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}

console.log('Provider Response Probe');
console.log('=======================');
console.log(`Time: ${new Date().toISOString()}\n`);

// Uncomment to probe streaming:
// for (const p of PROVIDERS) {
//   await probeStreaming(p);
// }

console.log('\n--- Models Endpoint Probe ---');
for (const e of MODEL_ENDPOINTS) {
  await probeModels(e);
}

console.log('\n\nDone.');
