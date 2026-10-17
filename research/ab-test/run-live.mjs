/**
 * Real-model A/B run against DeepSeek (or any OpenAI-compatible endpoint).
 *
 *   $env:DEEPSEEK_API_KEY = "sk-..."
 *   node ab-test/run-live.mjs --label deepseek-1 [--model deepseek-chat] [--rounds 1]
 *
 * Arm A: agent -> DeepSeek directly.
 * Arm B: agent -> headroom (fresh instance) -> DeepSeek.
 *
 * The model is reached directly, not through VS Code: that keeps the comparison exact and
 * avoids relying on the DeepSeek extension's own retry/formatting layer. The extension's
 * `deepseek-copilot.baseUrl` points at `${baseUrl}/chat/completions`, which is the same
 * contract the BCE transport exposes, so this measures the same hop.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLiveAgent } from './shared/live-agent.mjs';
import { scan } from './app/githubScout.mjs';
import { loadEnv } from './shared/env.mjs';
import { readCompressionLog, transformBreakdown } from './shared/headroomLog.mjs';
import { renderLiveReport } from './shared/live-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const loaded = loadEnv();
const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_KEY;
if (!apiKey) {
  console.error(
    'DEEPSEEK_API_KEY is not set. Put it in .env (git-ignored, see .env.example) or export it in the environment.'
  );
  process.exit(2);
}
console.log(`key: loaded from ${loaded.includes('DEEPSEEK_API_KEY') ? '.env' : 'the environment'} (never printed)`);

const label = arg('label', `deepseek-${Date.now()}`);
const model = arg('model', 'deepseek-chat');
const baseUrl = arg('baseUrl', 'https://api.deepseek.com');
const maxSteps = Number(arg('maxSteps', 10));
const headroomPort = Number(arg('headroomPort', 8787));
const headroomMode = arg('headroomMode', 'cache');

const runDir = join(here, 'runs', label);
mkdirSync(runDir, { recursive: true });

const children = [];
function start(name, command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}!] ${chunk}`));
  children.push({ name, child });
  return child;
}

function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function waitForHealth(url, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'healthy' || data.status === 'ok') return data;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`headroom at ${url} did not become healthy`);
}

function stopAll() {
  for (const { child } of children) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

async function main() {
  console.log('capturing one GitHub snapshot for both arms...');
  const snapshot = captureSnapshot({
    interesting: await scan({ queries: ['interesting'], perQuery: 8, enrichTop: 4 }),
    agents: await scan({ queries: ['agents'], perQuery: 8, enrichTop: 4 })
  });

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  console.log(`arm A: direct ${endpoint} (${model})...`);
  const armA = await runLiveAgent({ endpoint, apiKey, model, snapshot, maxSteps });

  const headroomStart = Date.now();
  // Headroom must forward to *your* provider, not to OpenAI: without an explicit target it
  // sends the body to api.openai.com and the real key is rejected there.
  // OPENAI_TARGET_API_URL is a base URL - Headroom appends the route itself.
  const headroomTarget = baseUrl.replace(/\/+$/, '');
  start('headroom', join(root, '.headroom-venv', 'Scripts', 'headroom.exe'), ['proxy', '--port', String(headroomPort), '--mode', headroomMode], {
    HEADROOM_BEACON: '0',
    OPENAI_TARGET_API_URL: headroomTarget,
    PYTHONUNBUFFERED: '1'
  });
  const health = await waitForHealth(`http://127.0.0.1:${headroomPort}`);
  console.log(`arm B: headroom ${health.version ?? '?'} -> ${headroomTarget}...`);
  const armB = await runLiveAgent({
    endpoint: `http://127.0.0.1:${headroomPort}/v1/chat/completions`,
    apiKey,
    model,
    snapshot,
    maxSteps
  });

  const log = readCompressionLog(headroomPort, headroomStart);
  const report = {
    label,
    at: new Date().toISOString(),
    model,
    headroomMode,
    headroomVersion: health.version ?? null,
    arms: { a: armA, b: armB },
    headroom: { transforms: transformBreakdown(log.events), logPath: log.path }
  };
  writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = renderLiveReport(report);
  writeFileSync(join(runDir, 'report.md'), markdown);
  console.log(markdown);
}

function captureSnapshot(results) {
  const snapshot = { queries: {}, requests: [], enriched: {} };
  for (const [key, result] of Object.entries(results)) {
    snapshot.queries[key] = {
      repositories: result.repositories,
      ranked: result.ranked.map((repo) => ({
        full_name: repo.full_name,
        language: repo.language,
        stars: repo.stars,
        score: repo.score,
        parts: repo.parts,
        topKeywords: repo.topKeywords,
        readmeBytes: repo.readmeBytes,
        tags: repo.tags,
        lastCommit: repo.lastCommit
      })),
      summary: result.summary
    };
    snapshot.requests.push(...result.requests);
  }
  return snapshot;
}

main()
  .then(() => {
    process.on('uncaughtException', () => undefined);
    stopAll();
    setTimeout(() => process.exit(0), 1000);
  })
  .catch((error) => {
    console.error(error);
    stopAll();
    setTimeout(() => process.exit(1), 1500);
  });
