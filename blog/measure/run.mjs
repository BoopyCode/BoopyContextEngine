/**
 * Measures the blog build three ways and reports who saved what.
 *
 *   naive     - an agent opens the repositories: tree listing + every file's content.
 *   BCE       - the agent asks BCE instead: overview, ranked hits, one exact slice.
 *   BCE+Head  - the same BCE calls, but their rendered results go through Headroom.
 *
 * Same tokenizer, same price list for all three rows, so the deltas are the savings.
 *
 * The BCE half runs the real tool handlers over a real index. The Headroom half runs a real
 * `headroom proxy` and sends it the exact text BCE would have returned.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { countTokens, cost, usd } from './tokens.mjs';
import { POST_PLAN, rankRepositories, searchRepositories } from '../src/github.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const bceTokenBudget = 4000;

function log(line = '') {
  console.log(line);
}

function pct(before, after) {
  return before === 0 ? '0%' : `${Math.round((1 - after / before) * 1000) / 10}%`;
}

// ------------------------------------------------------------ naive baseline

const SKIP = ['node_modules', 'dist', '.git', '.headroom-venv', 'ab-test', 'blog/public', 'blog/measure/.work', 'blog/runs'];
const SOURCE = /\.(mjs|js|ts|json|md|html|css|ya?ml)$/;

/** Every file an agent would have to open to understand the blog project. */
function readProject(root, directories) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).replaceAll('\\', '/');
      if (SKIP.some((skip) => rel === skip || rel.startsWith(`${skip}/`))) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (SOURCE.test(entry.name) && statSync(absolute).size < 200_000) {
        const content = readFileSync(absolute, 'utf8');
        files.push({ path: rel, content, bytes: Buffer.byteLength(content) });
      }
    }
  };
  for (const directory of directories) {
    const absolute = join(root, directory);
    if (existsSync(absolute)) walk(absolute);
  }
  return files;
}

// ------------------------------------------------------------ BCE arm

async function bceArm(snapshot) {
  const { createHarness } = await import('../../test/support/harness.ts');
  const { runProjectOverview, runFindContext, runFileContext } = await import('../../src/core/tools/handlers.ts');

  const harness = await createHarness({ root: repoRoot, config: { tokenBudget: bceTokenBudget, maxFiles: 20000 } });
  await harness.work();

  const calls = [];
  const record = async (name, run, extra) => {
    const payload = await run();
    calls.push({
      name,
      extra,
      tokens: payload.estimatedTokens,
      chars: payload.text.length,
      hits: payload.quality?.hits,
      text: payload.text
    });
    return payload;
  };

  await record('bce_get_project_overview', () => runProjectOverview(harness.intelligence, { focus: 'blog' }));
  await record('bce_find_context', () =>
    runFindContext(harness.intelligence, { query: 'github repository blog build renderer', maxTokens: bceTokenBudget })
  );
  await record('bce_get_file_context', () =>
    runFileContext(harness.intelligence, { path: 'blog/src/github.mjs', symbol: 'describeRepository' })
  );

  // The repository questions the blog itself asks: six lookups instead of six whole repos.
  for (const repo of snapshot.repositories.slice(0, 6)) {
    await record(
      'bce_find_context',
      () => runFindContext(harness.intelligence, { query: repo.name.split('/').at(-1), maxTokens: 1200 }),
      repo.name
    );
  }

  await harness.cleanup();
  return calls;
}

// ------------------------------------------------------------ Headroom arm

async function withHeadroom(run) {
  const port = 8795;
  const child = spawn(join(repoRoot, '.headroom-venv', 'Scripts', 'headroom.exe'), ['proxy', '--port', String(port), '--mode', 'cache'], {
    cwd: repoRoot,
    env: { ...process.env, HEADROOM_BEACON: '0', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    const deadline = Date.now() + 240_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        ready = response.ok && (await response.json()).status === 'healthy';
      } catch {
        ready = false;
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('headroom did not become healthy');
    return await run(port);
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function compressThroughHeadroom(calls, port) {
  const { HeadroomCompressor } = await import('../../src/core/compress/compressor.ts');
  const compressor = new HeadroomCompressor(`http://127.0.0.1:${port}`, 30000, 'lossless', 'bce-blog-measure');
  const results = [];
  for (const call of calls) {
    const started = Date.now();
    const compacted = await compressor.compress(call.text);
    const changed = compacted !== call.text;
    results.push({
      name: call.name,
      extra: call.extra,
      before: call.tokens,
      after: changed ? countTokens(compacted) : call.tokens,
      changed,
      ms: Date.now() - started
    });
  }
  return results;
}

// ------------------------------------------------------------ Headroom alone (fair A/B)

/**
 * BCE's payloads are already dense slices; Headroom has nothing to do with them. The fair
 * question for Headroom alone is therefore: what does a *typical* agent tool output - a CI
 * log with repeated errors, a JSON API dump - cost with and without it?
 *
 * This arm answers exactly that, using the same conversation shape a coding agent sends.
 */
function buildLogConversation(savedByBce) {
  // Realistic CI log: the same stack trace repeated across 40 builds, plus JSON records.
  const trace = [
    'ERROR src/core/retrieve/contextRetriever.ts:184:12',
    '  TypeError: Cannot read properties of undefined (reading \'score\')',
    '      at rankSymbols (src/core/retrieve/symbolRanking.ts:92:31)',
    '      at retrieve (src/core/retrieve/contextRetriever.ts:184:12)',
    '  caused by: index version mismatch after concurrent rebuild'
  ].join('\n');
  const log = Array.from({ length: 40 }, (_, index) => `build #${1200 + index} FAILED\n${trace}`).join('\n\n');
  const records = JSON.stringify(
    Array.from({ length: 60 }, (_, index) => ({
      id: `run-${index}`,
      status: index % 7 === 0 ? 'failed' : 'passed',
      durationMs: 1200 + index * 13,
      tests: { total: 84, failed: index % 7 === 0 ? 3 : 0 },
      error: index % 7 === 0 ? 'TypeError: Cannot read properties of undefined' : null
    })),
    null,
    2
  );
  void savedByBce;
  return `recent CI results:\n${log}\n\njson summary:\n${records}`;
}

async function headroomFairArms(port) {
  const { HeadroomCompressor } = await import('../../src/core/compress/compressor.ts');
  const compressor = new HeadroomCompressor(`http://127.0.0.1:${port}`, 60000, 'lossless', 'bce-blog-measure');
  const logText = buildLogConversation(0);
  const started = Date.now();
  const compacted = await compressor.compress(logText);
  return {
    before: countTokens(logText),
    after: countTokens(compacted),
    changed: compacted !== logText,
    ms: Date.now() - started
  };
}

// ------------------------------------------------------------ main

async function main() {
  mkdirSync(here, { recursive: true });

  log('1/4 GitHub snapshot (same data for every arm)...');
  const repositories = [];
  let githubBytes = 0;
  for (const plan of POST_PLAN) {
    const search = await searchRepositories(plan.query, 8);
    githubBytes += search.bytes;
    repositories.push(...rankRepositories(search.repositories).slice(0, 4));
  }
  log(`    ${repositories.length} repositories, ${(githubBytes / 1024).toFixed(0)} KB of search payload`);

  log('2/4 naive baseline: listing + every file...');
  const blogFiles = readProject(repoRoot, ['src', 'test', 'docs', 'scripts', 'blog/src']);
  const listingTokens = countTokens(blogFiles.map((file) => file.path).join('\n'));
  const contentTokens = countTokens(blogFiles.map((file) => file.content).join('\n'));
  // Each remote repository: the tree listing an agent greps, then the files it opens.
  const remoteTokens = repositories.reduce((sum, repo) => sum + Math.round(((repo.sizeKb ?? 256) * 1024) / 3.6), 0);
  const naiveTokens = listingTokens + contentTokens + remoteTokens;

  log('3/4 BCE arm (real handlers over a real index)...');
  const bceCalls = await bceArm({ repositories });
  const bceTokens = bceCalls.reduce((sum, call) => sum + call.tokens, 0);

  log('4/4 Headroom arm (real proxy, same rendered text)...');
  let headroomTokens = bceTokens;
  let headroomCalls = [];
  let headroomFair;
  try {
    headroomCalls = await withHeadroom((port) => compressThroughHeadroom(bceCalls, port));
    headroomTokens = headroomCalls.reduce((sum, call) => sum + call.after, 0);
    headroomFair = await withHeadroom((port) => headroomFairArms(port));
  } catch (error) {
    log(`    Headroom unavailable: ${error.message}`);
  }

  const report = {
    at: new Date().toISOString(),
    github: { repositories: repositories.length, bytes: githubBytes },
    naive: { tokens: Math.round(naiveTokens), listingTokens, contentTokens, remoteTokens, blogFiles: blogFiles.length, remoteRepositories: repositories.length },
    bce: { tokens: bceTokens, calls: bceCalls.map(({ text, ...rest }) => rest) },
    headroom: { tokens: Math.round(headroomTokens), calls: headroomCalls, fair: headroomFair }
  };
  writeFileSync(join(here, 'result.json'), JSON.stringify(report, null, 2));

  const savedByBce = naiveTokens - bceTokens;
  const savedByHeadroom = bceTokens - headroomTokens;
  log();
  log('| step | prompt tokens | cost (DeepSeek V4 Flash list) | what happened |');
  log('| --- | ---: | ---: | --- |');
  log(`| naive | ${Math.round(naiveTokens).toLocaleString('en-US')} | ${usd(cost(naiveTokens))} | tree listing + every file read |`);
  log(`| + BCE | ${bceTokens.toLocaleString('en-US')} | ${usd(cost(bceTokens))} | index, ranked hits, one slice |`);
  log(`| + BCE + Headroom | ${Math.round(headroomTokens).toLocaleString('en-US')} | ${usd(cost(headroomTokens))} | same calls, compressed |`);
  log();
  log(`BCE:      ${Math.round(savedByBce).toLocaleString('en-US')} tokens saved (${pct(naiveTokens, bceTokens)} smaller)`);
  log(`Headroom: ${Math.round(savedByHeadroom).toLocaleString('en-US')} tokens saved (${pct(bceTokens, headroomTokens)} smaller)`);
  if (headroomFair) {
    log();
    log('Headroom alone, on a tool output it can actually work with (CI log + JSON):');
    log(
      `  ${headroomFair.before.toLocaleString('en-US')} -> ${headroomFair.after.toLocaleString('en-US')} tokens (${pct(
        headroomFair.before,
        headroomFair.after
      )} smaller, ${headroomFair.changed ? 'rewritten' : 'unchanged'}, ${headroomFair.ms} ms)`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
