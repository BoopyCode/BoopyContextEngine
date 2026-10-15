/**
 * Measures a BCE bundle through the real extension surface.
 *
 * It installs a small stand-in for the `vscode` module (the same one the test suite
 * uses), activates the given `dist/extension.js`, waits for the index and then drives
 * the actual language model tools and the `BCE: Run Local Benchmark` command. That
 * makes the numbers comparable between a development bundle and the bundle of an
 * installed extension, because exactly the same code path runs in both cases.
 *
 *   node scripts/measure.mjs --bundle dist/extension.js --label dev-build
 *   node scripts/measure.mjs --bundle "%USERPROFILE%/.vscode/extensions/<id>/dist/extension.js" --label installed
 *   node scripts/measure.mjs --compare .bce-measure-dev-build.json .bce-measure-installed.json
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(name);

async function main() {
  if (has('--compare')) {
    const files = args.filter((value) => value.endsWith('.json'));
    await compare(files[0], files[1]);
    return;
  }

  const bundle = path.resolve(flag('--bundle', path.join(repoRoot, 'dist', 'extension.js')));
  const label = flag('--label', path.basename(path.dirname(bundle)));
  const project = path.resolve(flag('--project', path.join(os.tmpdir(), 'bce-bench-project')));
  const searchRounds = Number.parseInt(flag('--searches', '3'), 10);
  const singleRound = has('--single-round');
  const requestedRounds = Math.max(Number.parseInt(flag('--rounds', '3'), 10), 1);
  const roundCount = singleRound ? 1 : requestedRounds;
  const jsonOut = flag('--json', path.join(repoRoot, `.bce-measure-${label}.json`));

  if (!(await fs.stat(bundle).catch(() => undefined))) {
    throw new Error(`Bundle not found: ${bundle}`);
  }

  // 1. identical project shape for every run
  if (!has('--keep-project')) {
    run('node', [path.join(repoRoot, 'scripts', 'generate-project.mjs'), project]);
  }

  // Repeated rounds run in separate processes: a reused process carries heap and warm
  // caches from the previous round, which would flatter the later numbers.
  if (roundCount > 1) {
    const sampleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bce-measure-samples-'));
    const samples = [];
    for (let index = 0; index < roundCount; index += 1) {
      const file = path.join(sampleDir, `round-${index + 1}.json`);
      console.log(`round ${index + 1}/${roundCount}...`);
      run('node', [
        fileURLToPath(import.meta.url),
        '--bundle',
        bundle,
        '--label',
        `${label} round ${index + 1}`,
        '--project',
        project,
        '--keep-project',
        '--single-round',
        '--searches',
        String(searchRounds),
        '--json',
        file
      ]);
      samples.push(JSON.parse(await fs.readFile(file, 'utf8')));
    }
    const measurement = aggregate(label, bundle, project, samples);
    await fs.writeFile(jsonOut, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
    printTable(measurement);
    console.log(`\nJSON: ${jsonOut}`);
    await fs.rm(sampleDir, { recursive: true, force: true });
    return;
  }

  const tasksFile = path.join(project, '.bce-benchmark.json');
  const declaredTasks = await fs
    .readFile(tasksFile, 'utf8')
    .then((text) => JSON.parse(text).tasks ?? [])
    .catch(() => []);

  // 2. build the vscode stand-in and let the bundle resolve 'vscode' to it
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bce-measure-stub-'));
  const stubFile = path.join(stubDir, 'vscode-stub.cjs');
  run('node', [
    path.join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(repoRoot, 'test', 'mocks', 'vscode.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${stubFile}`
  ]);
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveFilename(request, ...rest) {
    if (request === 'vscode') {
      return stubFile;
    }
    return originalResolve.call(this, request, ...rest);
  };

  const vscode = require(stubFile);
  const { __mock } = vscode;
  __mock.setWorkspaceFolders([project]);

  const bundleBytes = (await fs.stat(bundle)).size;
  const extension = require(bundle);
  const rounds = [];

  // 3. every round indexes from scratch (fresh storage), so the numbers include the
  //    cold disk path an activating user actually hits.
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'bce-measure-storage-'));
    const context = { subscriptions: [], storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) };
    const memoryBefore = process.memoryUsage();

    const activatedAt = performance.now();
    await extension.activate(context);
    const ready = await waitFor(async () => {
      const status = textOf(await __mock.invokeTool('bce_get_status', { verbose: true }));
      return status.includes('complete: true') ? status : undefined;
    }, 180000);
    const readyAt = performance.now();
    const memoryIndexed = process.memoryUsage();

    // The extension's own benchmark first: it either reads <project>/.bce-benchmark.json or
    // derives tasks from the indexed project, which is what makes any repository measurable.
    const outputBefore = __mock.state.outputLines.length;
    await vscode.commands.executeCommand('bce.runBenchmark');
    const results = parseBenchmarkReport(__mock.state.outputLines.slice(outputBefore).join('\n'));
    const queries = results.tasks.length > 0 ? results.tasks.map((task) => task.query) : declaredTasks.map((task) => task.query);

    const latency = [];
    for (let pass = 0; pass < searchRounds; pass += 1) {
      for (const query of queries) {
        const started = performance.now();
        await __mock.invokeTool('bce_find_context', { query });
        latency.push(performance.now() - started);
      }
    }
    const memoryAfterSearch = process.memoryUsage();
    const firstCallMs = round(latency[0]);
    const sorted = [...latency].sort((a, b) => a - b);

    await fs.rm(storage, { recursive: true, force: true });
    extension.deactivate();
    await new Promise((resolve) => setTimeout(resolve, 250));

    rounds.push({
      filesIndexed: Number.parseInt(/,\s(\d+) file\(s\) indexed/.exec(ready)?.[1] ?? '0', 10),
      ignoredPaths: Number.parseInt(/,\s(\d+) ignored/.exec(ready)?.[1] ?? '0', 10),
      indexRunMs: Number.parseInt(/last run (\d+) ms/.exec(ready)?.[1] ?? '0', 10),
      activationAndIndexMs: Math.round(readyAt - activatedAt),
      search: {
        calls: latency.length,
        firstCallMs,
        p50Ms: round(sorted[Math.floor(sorted.length * 0.5)]),
        p95Ms: round(sorted[Math.floor(sorted.length * 0.95)]),
        maxMs: round(sorted[sorted.length - 1])
      },
      memory: {
        beforeMb: toMb(memoryBefore.heapUsed),
        afterIndexMb: toMb(memoryIndexed.heapUsed),
        afterSearchesMb: toMb(memoryAfterSearch.heapUsed),
        rssMb: toMb(memoryAfterSearch.rss)
      },
      benchmark: {
        tasks: results.tasks.length,
        hitRate: results.hitRate,
        meanRank: results.meanRank,
        bceTokens: results.bceTokens,
        baselineTokens: results.baselineTokens,
        savedPercent: results.savedPercent,
        perTask: results.tasks
      }
    });
  }

  const median = (read) => round(medianOf(rounds.map(read)));
  const benchmark = rounds[rounds.length - 1].benchmark;
  const measurement = {
    label,
    bundle,
    bundleBytes,
    project,
    rounds: roundCount,
    filesIndexed: rounds[0].filesIndexed,
    ignoredPaths: rounds[0].ignoredPaths,
    indexRunMs: median((entry) => entry.indexRunMs),
    activationAndIndexMs: median((entry) => entry.activationAndIndexMs),
    tasks: benchmark.tasks,
    hitRate: benchmark.hitRate,
    meanRank: benchmark.meanRank,
    bceTokens: benchmark.bceTokens,
    baselineTokens: benchmark.baselineTokens,
    savedPercent: benchmark.savedPercent,
    search: {
      calls: rounds[0].search.calls,
      firstCallMs: median((entry) => entry.search.firstCallMs),
      p50Ms: median((entry) => entry.search.p50Ms),
      p95Ms: median((entry) => entry.search.p95Ms),
      maxMs: median((entry) => entry.search.maxMs)
    },
    memory: {
      beforeMb: median((entry) => entry.memory.beforeMb),
      afterIndexMb: median((entry) => entry.memory.afterIndexMb),
      afterSearchesMb: median((entry) => entry.memory.afterSearchesMb),
      rssMb: median((entry) => entry.memory.rssMb)
    },
    perTask: benchmark.perTask,
    benchmark,
    samples: rounds,
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, vscodeApi: vscode.version }
  };

  await fs.writeFile(jsonOut, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
  printTable(measurement);
  console.log(`\nJSON: ${jsonOut}`);
  await fs.rm(stubDir, { recursive: true, force: true });
}

/** Median of independent single-round measurements (one process per round). */
function aggregate(label, bundle, project, rawSamples) {
  const samples = rawSamples.map(({ indexRunMs, activationAndIndexMs, filesIndexed, ignoredPaths, search, memory, benchmark }) => ({
    indexRunMs,
    activationAndIndexMs,
    filesIndexed,
    ignoredPaths,
    search,
    memory,
    benchmark
  }));
  const median = (read) => round(medianOf(samples.map(read)));
  const first = samples[0];
  const environment = rawSamples[0].environment;
  const benchmark = first.benchmark;
  return {
    label,
    bundle,
    bundleBytes: rawSamples[0].bundleBytes,
    project,
    rounds: samples.length,
    filesIndexed: first.filesIndexed,
    ignoredPaths: first.ignoredPaths,
    indexRunMs: median((entry) => entry.indexRunMs),
    activationAndIndexMs: median((entry) => entry.activationAndIndexMs),
    tasks: benchmark.tasks,
    hitRate: benchmark.hitRate,
    meanRank: benchmark.meanRank,
    bceTokens: benchmark.bceTokens,
    baselineTokens: benchmark.baselineTokens,
    savedPercent: benchmark.savedPercent,
    search: {
      calls: first.search.calls,
      firstCallMs: median((entry) => entry.search.firstCallMs),
      p50Ms: median((entry) => entry.search.p50Ms),
      p95Ms: median((entry) => entry.search.p95Ms),
      maxMs: median((entry) => entry.search.maxMs)
    },
    memory: {
      beforeMb: median((entry) => entry.memory.beforeMb),
      afterIndexMb: median((entry) => entry.memory.afterIndexMb),
      afterSearchesMb: median((entry) => entry.memory.afterSearchesMb),
      rssMb: median((entry) => entry.memory.rssMb)
    },
    perTask: benchmark.perTask,
    samples,
    environment
  };
}

function textOf(result) {
  return result.content[0].value;
}

function toMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function round(value) {
  return value === undefined ? 0 : Math.round(value * 10) / 10;
}

function medianOf(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the index');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function parseBenchmarkReport(report) {
  const summary = /hit rate: ([\d.]+)%?\s*,\s*mean rank of first correct hit: ([\d.]+),\s*estimated context: ~(\d+) tokens vs ~(\d+) tokens for the naive baseline \(([\d.]+)% smaller\)/.exec(
    report
  );
  const tasks = [];
  const blockPattern = /- (.+?): "(.+?)"\n\s+(found at rank (\d+)|not found)(?:, top hits: (.*))?\n\s+~(\d+) bce tokens vs ~(\d+) baseline tokens \((\d+) candidate file\(s\)\), (\d+) ms/g;
  for (const match of report.matchAll(blockPattern)) {
    tasks.push({
      id: match[1],
      query: match[2],
      found: (match[3] ?? '').startsWith('found at rank'),
      rank: match[4] ? Number.parseInt(match[4], 10) : null,
      topHits: (match[5] ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      bceTokens: Number.parseInt(match[6], 10),
      baselineTokens: Number.parseInt(match[7], 10),
      candidateFiles: Number.parseInt(match[8], 10),
      durationMs: Number.parseInt(match[9], 10)
    });
  }
  return {
    hitRate: summary ? Number.parseFloat(summary[1]) : 0,
    meanRank: summary ? Number.parseFloat(summary[2]) : 0,
    bceTokens: summary ? Number.parseInt(summary[3], 10) : 0,
    baselineTokens: summary ? Number.parseInt(summary[4], 10) : 0,
    savedPercent: summary ? Number.parseFloat(summary[5]) : 0,
    tasks
  };
}

function printTable(measurement) {
  console.log(`\n=== BCE measurement: ${measurement.label} ===`);
  console.log(`bundle:            ${measurement.bundle}`);
  console.log(`project:           ${measurement.project}`);
  console.log(`environment:       node ${measurement.environment.node}, vscode api ${measurement.environment.vscodeApi}`);
  console.log('');
  console.log(`bundle size:       ${(measurement.bundleBytes / 1024).toFixed(0)} KB`);
  console.log(`files indexed:     ${measurement.filesIndexed} (${measurement.ignoredPaths} ignored path(s))`);
  console.log(`index run:         ${measurement.indexRunMs} ms (median of ${measurement.rounds} round(s): ${measurement.samples.map((entry) => entry.indexRunMs).join(', ')})`);
  console.log(`activate + index:  ${measurement.activationAndIndexMs} ms`);
  console.log('');
  console.log(`search latency:    first call ${measurement.search.firstCallMs} ms, p50 ${measurement.search.p50Ms} ms, p95 ${measurement.search.p95Ms} ms, max ${measurement.search.maxMs} ms (${measurement.search.calls} calls)`);
  console.log(`memory (heapUsed): ${measurement.memory.beforeMb} MB -> ${measurement.memory.afterIndexMb} MB after index -> ${measurement.memory.afterSearchesMb} MB after searches (rss ${measurement.memory.rssMb} MB)`);
  console.log('');
  console.log(`benchmark tasks:   ${measurement.tasks}, hit rate ${measurement.hitRate}%, mean rank ${measurement.meanRank}`);
  console.log(`context size:      ~${measurement.bceTokens} tokens (BCE) vs ~${measurement.baselineTokens} tokens (naive baseline) -> ${measurement.savedPercent}% smaller`);
  console.log('');
  console.log('per task:');
  for (const task of measurement.perTask) {
    console.log(
      `  ${task.id.padEnd(18)} ${task.found ? `rank ${String(task.rank).padEnd(2)}` : 'MISS  '} ~${String(task.bceTokens).padStart(5)} vs ~${String(task.baselineTokens).padStart(5)} tokens (${String(task.candidateFiles).padStart(2)} files) ${task.durationMs} ms`
    );
  }
}

async function compare(firstFile, secondFile) {
  if (!firstFile || !secondFile) {
    throw new Error('Usage: --compare <a.json> <b.json>');
  }
  const first = JSON.parse(await fs.readFile(path.resolve(firstFile), 'utf8'));
  const second = JSON.parse(await fs.readFile(path.resolve(secondFile), 'utf8'));
  const rows = [
    ['bundle size (KB)', (value) => (value.bundleBytes / 1024).toFixed(0)],
    ['files indexed', (value) => value.filesIndexed],
    ['index run (ms)', (value) => value.indexRunMs],
    ['activate + index (ms)', (value) => value.activationAndIndexMs],
    ['search p50 (ms)', (value) => value.search.p50Ms],
    ['search p95 (ms)', (value) => value.search.p95Ms],
    ['hit rate (%)', (value) => value.hitRate],
    ['mean rank', (value) => value.meanRank],
    ['BCE tokens (all tasks)', (value) => value.bceTokens],
    ['baseline tokens', (value) => value.baselineTokens],
    ['saved (%)', (value) => value.savedPercent],
    ['heap after index (MB)', (value) => value.memory.afterIndexMb],
    ['heap after searches (MB)', (value) => value.memory.afterSearchesMb]
  ];
  console.log(`\n=== comparison: ${first.label} -> ${second.label} ===\n`);
  console.log(`${'metric'.padEnd(26)} ${'before'.padStart(12)} ${'after'.padStart(12)} ${'delta'.padStart(12)}`);
  for (const [name, read] of rows) {
    const before = read(first);
    const after = read(second);
    const delta = typeof before === 'number' && typeof after === 'number' ? after - before : '';
    const shown = typeof delta === 'number' ? `${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100}` : '';
    console.log(`${name.padEnd(26)} ${String(before).padStart(12)} ${String(after).padStart(12)} ${shown.padStart(12)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
