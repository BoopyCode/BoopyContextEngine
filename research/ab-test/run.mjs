/**
 * A/B harness: the same GitHub-scout agent runs twice, with and without Headroom.
 *
 *   node ab-test/run.mjs --label run-1 [--rounds 1] [--headroomMode cache|token]
 *
 * Start-up order follows where the data must go, not convenience:
 *   1. the mock model starts on two ports (direct :8811, via-headroom :8812),
 *   2. Headroom starts, pointed at the via-headroom port,
 *   3. the GitHub snapshot is captured once,
 *   4. arm A and arm B run the identical agent loop against their own recording proxy.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from './shared/agent.mjs';
import { scan } from './app/githubScout.mjs';
import { renderReport } from './shared/report.mjs';
import { readCompressionLog, transformBreakdown } from './shared/headroomLog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const label = arg('label', `run-${Date.now()}`);
const rounds = Number(arg('rounds', 1));
const headroomMode = arg('headroomMode', 'cache');
/**
 * `--control headroom-off` runs arm B against a *passthrough* Headroom (`--no-optimize`).
 * A sound harness must then report ~0% - if it reports savings, the measurement is
 * picking up something other than compression.
 */
const controlMode = arg('control', '');
const DIRECT_PORT = Number(arg('directPort', 8811));
const HEADROOM_MODEL_PORT = Number(arg('headroomModelPort', 8812));
const HEADROOM_PORT = Number(arg('headroomPort', 8787));
const PROXY_A_PORT = Number(arg('proxyAPort', 8813));
const PROXY_B_PORT = Number(arg('proxyBPort', 8814));

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

function waitForPort(port, timeoutMs = 90000) {
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
        else setTimeout(attempt, 400);
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

/**
 * The live GitHub read happens once here; the tools then read the same numbers from the
 * snapshot. Without this the second arm would see different repositories and the
 * comparison would be meaningless.
 */
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

async function main() {
  const startedAll = Date.now();
  const modelLog = join(runDir, 'model.jsonl');
  start('model', process.execPath, [join(here, 'shared', 'model-server.mjs'), String(DIRECT_PORT), String(HEADROOM_MODEL_PORT), modelLog]);
  await waitForPort(DIRECT_PORT);
  await waitForPort(HEADROOM_MODEL_PORT);

  console.log('capturing one GitHub snapshot for both arms...');
  const snapshot = captureSnapshot({
    interesting: await scan({ queries: ['interesting'], perQuery: 8, enrichTop: 4 }),
    agents: await scan({ queries: ['agents'], perQuery: 8, enrichTop: 4 })
  });

  const armALog = join(runDir, 'arm-a.jsonl');
  const armBLog = join(runDir, 'arm-b.jsonl');

  // A fresh proxy process per arm: a shared Headroom session would replay arm A's
  // prefix state into arm B and quietly flatter the result.
  let headroomVersion;

  start('proxyA', process.execPath, [
    join(here, 'shared', 'proxy.mjs'),
    '--port', String(PROXY_A_PORT),
    '--modelUrl', `http://127.0.0.1:${DIRECT_PORT}`,
    '--log', armALog
  ]);
  await waitForPort(PROXY_A_PORT);
  console.log('arm A (direct to the model)...');
  const armA = await runAgentLoop({ endpoint: `http://127.0.0.1:${PROXY_A_PORT}/v1/chat/completions`, snapshot, rounds });

  const headroomChild = start('headroom', join(root, '.headroom-venv', 'Scripts', 'headroom.exe'), [
    'proxy',
    '--port', String(HEADROOM_PORT),
    '--mode', headroomMode,
    ...(controlMode === 'headroom-off' ? ['--no-optimize'] : [])
  ], {
    HEADROOM_BEACON: '0',
    OPENAI_TARGET_API_URL: `http://127.0.0.1:${HEADROOM_MODEL_PORT}`,
    PYTHONUNBUFFERED: '1'
  });
  void headroomChild;
  const headroomStartedAt = Date.now();
  const health = await waitForHealth(`http://127.0.0.1:${HEADROOM_PORT}`);
  headroomVersion = health.version;
  console.log(`headroom healthy (${health.version ?? '?'}, mode ${headroomMode}), fresh session for arm B`);

  start('proxyB', process.execPath, [
    join(here, 'shared', 'proxy.mjs'),
    '--port', String(PROXY_B_PORT),
    '--upstream', 'headroom',
    '--headroomUrl', `http://127.0.0.1:${HEADROOM_PORT}`,
    '--modelUrl', `http://127.0.0.1:${HEADROOM_PORT}`,
    '--stack', 'bce-ab-test',
    '--log', armBLog
  ]);
  await waitForPort(PROXY_B_PORT);
  console.log('arm B (through a freshly started headroom)...');
  const armB = await runAgentLoop({ endpoint: `http://127.0.0.1:${PROXY_B_PORT}/v1/chat/completions`, snapshot, rounds });

  const log = readCompressionLog(HEADROOM_PORT, headroomStartedAt);

  const report = {
    label,
    startedAt: new Date(startedAll).toISOString(),
    durationMs: Date.now() - startedAll,
    headroomMode,
    headroomVersion: headroomVersion ?? null,
    rounds,
    control: controlMode,
    github: {
      requests: snapshot.requests,
      toolOutputBytes: snapshot.requests.reduce((sum, request) => sum + request.bytes, 0),
      repositories: snapshot.queries.interesting?.repositories ?? 0,
      queries: Object.keys(snapshot.queries)
    },
    headroom: {
      logPath: log.path,
      transforms: transformBreakdown(log.events),
      savedEvents: log.events.filter((event) => event.kind === 'saved').map((event) => ({ before: event.before, after: event.after, saved: event.saved }))
    },
    arms: { a: armA, b: armB }
  };
  writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = renderReport(report);
  writeFileSync(join(runDir, 'report.md'), markdown);
  console.log(markdown);
}

main()
  .then(() => {
    // On Windows a killed child can surface as an asynchronous error after the report is
    // written; that must not turn a successful measurement into `exit 1`.
    process.on('uncaughtException', () => undefined);
    stopAll();
    setTimeout(() => process.exit(0), 1000);
  })
  .catch((error) => {
    console.error(error);
    stopAll();
    // Still exit non-zero on a real failure, but only after the children are gone so the
    // Windows "process exited" noise cannot mask the message above.
    setTimeout(() => process.exit(1), 2000);
  });
