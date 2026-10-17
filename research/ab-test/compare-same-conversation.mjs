/**
 * Paired measurement: the *same* conversation, sent to DeepSeek with and without Headroom.
 *
 * Why this exists: the agentic A/B lets the model choose its own tool calls, so the two
 * arms can diverge by turn 2 and the totals stop being comparable. This script removes
 * that variable by replaying one fixed, long conversation through both paths and reading
 * the provider's own `usage` for each request.
 *
 *   node ab-test/compare-same-conversation.mjs [--turns 3]
 *
 * Uses DEEPSEEK_API_KEY from .env. Shows both raw token counts and the *cache-aware* cost,
 * because DeepSeek bills a cache hit at roughly 1/30 of a miss.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './shared/env.mjs';
import { runLiveAgent } from './shared/live-agent.mjs';
import { scan } from './app/githubScout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
loadEnv();

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('DEEPSEEK_API_KEY missing (put it in .env)');
  process.exit(2);
}
const model = 'deepseek-chat';
const port = 8794;
const baseUrl = 'https://api.deepseek.com';

const children = [];
function start(args, env) {
  const child = spawn(join(root, '.headroom-venv', 'Scripts', 'headroom.exe'), args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[headroom] ${chunk}`));
  children.push(child);
  return child;
}
const stop = () => children.forEach((child) => child.kill());
async function waitHealthy(url, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).status === 'healthy') return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('headroom did not start');
}

/** One fixed conversation with a lot of tool output: the shape compression targets. */
function conversation() {
  const rows = (label) => ({
    type: 'function_call_output',
    call_id: `call_${label}`,
    name: 'github_search',
    status: 'completed',
    output: `${label}:\n${JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        path: `src/module-${index % 6}/file-${index}.ts`,
        line: index * 3 + 1,
        kind: index % 8 === 0 ? 'ERROR' : 'match',
        text: index % 8 === 0 ? `failed to resolve ${index}` : `export function handler${index}() { return ${index}; }`
      })),
      null,
      2
    )}`
  });
  const call = (label) => ({
    type: 'function_call',
    call_id: `call_${label}`,
    name: 'github_search',
    arguments: JSON.stringify({ query: label })
  });
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find and compare interesting repositories.' }] }
  ];
  for (const label of ['interesting', 'agents', 'tooling']) {
    input.push(call(label), rows(label));
  }
  input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now recommend three repositories.' }] });
  return input;
}

async function post(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

const body = {
  model,
  input: conversation(),
  stream: false,
  max_tokens: 64
};

// The exact same text both arms see, in the format deepseek-chat serves.
const messages = [
  { role: 'user', content: 'Find and compare interesting repositories.' },
  ...body.input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => ({ role: 'user', content: item.output })),
  { role: 'user', content: 'Now recommend three repositories.' }
];

console.log(`conversation: ${messages.length} messages, ${JSON.stringify(messages).length} bytes`);

// Same conversation, both paths, chat/completions (what deepseek-chat actually serves).
const directChat = await post(`${baseUrl}/chat/completions`, { model, messages, max_tokens: 64, stream: false });
if (!directChat.usage) {
  console.error('The direct call returned no usage block; cannot measure without it.');
  process.exit(1);
}

start(['proxy', '--port', String(port), '--mode', 'cache'], {
  HEADROOM_BEACON: '0',
  OPENAI_TARGET_API_URL: baseUrl
});
await waitHealthy(`http://127.0.0.1:${port}`);

const headroomChat = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
  model,
  messages,
  max_tokens: 64,
  stream: false
});

const summarize = (label, usage) => {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_cache_hit_tokens ?? 0;
  const miss = Math.max(0, prompt - cached);
  const cost = (miss / 1e6) * 0.22 + (cached / 1e6) * 0.007 + ((usage?.completion_tokens ?? 0) / 1e6) * 0.66;
  return { label, prompt, cached, miss, completion: usage?.completion_tokens ?? 0, cost, raw: JSON.stringify(usage) };
};

const a = summarize('direct', directChat.usage);
const b = summarize('headroom', headroomChat.usage);
const pct = (x, y) => (x === 0 ? '0%' : `${Math.round((1 - y / x) * 1000) / 10}%`);
console.log(`usage direct:   ${a.raw}`);
console.log(`usage headroom: ${b.raw}`);

console.log('');
console.log('| metric | direct | headroom | change |');
console.log('| --- | ---: | ---: | ---: |');
console.log(`| prompt tokens | ${a.prompt} | ${b.prompt} | ${pct(a.prompt, b.prompt)} smaller |`);
console.log(`| cache hits | ${a.cached} | ${b.cached} | |`);
console.log(`| cache misses | ${a.miss} | ${b.miss} | ${pct(a.miss, b.miss)} |`);
console.log(`| completion tokens | ${a.completion} | ${b.completion} | |`);
console.log(`| cost (USD, list) | $${a.cost.toFixed(6)} | $${b.cost.toFixed(6)} | ${pct(a.cost, b.cost)} cheaper |`);

stop();
process.on('uncaughtException', () => undefined);
setTimeout(() => process.exit(0), 800);
