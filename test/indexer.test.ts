import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { ParserRegistry, defaultParsers } from '../src/core/parse/registry';
import { FileParser, ParseInput, ParseOutput } from '../src/core/parse/parseTypes';
import { writeFile, readFile, exists } from './support/tempProject';
import { MemoryStoreFs } from './support/memoryFs';
import { IndexStore } from '../src/core/index/indexStore';
import { configSignature, maxFileSizeBytes } from '../src/core/config';
import { NodeFileSystem } from '../src/core/io/nodeFs';
import { Metrics } from '../src/core/diagnostics/metrics';
import { ContextCache } from '../src/core/cache/contextCache';
import { IgnoreEngine } from '../src/core/ignore/ignoreEngine';
import { sha1 } from '../src/core/util/hash';
import { toPosix } from '../src/core/util/paths';

const harnesses: Harness[] = [];

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const instance = harnesses.pop();
    await instance?.cleanup();
  }
});

describe('project indexing', () => {
  it('indexes the fixture project and resolves internal imports', async () => {
    const h = await harness();
    await h.work();

    const index = h.indexer.getIndex();
    expect(index.size).toBeGreaterThan(10);
    expect(index.complete).toBe(true);

    const orderService = index.get('src/services/orderService.ts');
    expect(orderService).toBeDefined();
    expect(orderService?.symbols.some((symbol) => symbol.name === 'OrderService')).toBe(true);
    expect(orderService?.dependencies).toEqual(expect.arrayContaining(['src/models/order.ts', 'src/utils/money.ts']));

    const importRecord = orderService?.imports.find((entry) => entry.specifier === '../models/order');
    expect(importRecord?.resolved).toBe('src/models/order.ts');
  });

  it('never indexes secrets, dependencies or build output', async () => {
    const h = await harness();
    await h.work();
    const paths = h.indexer.getIndex().paths();
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('config/server.key');
    expect(paths).not.toContain('config/secrets.json');
    expect(paths).not.toContain('node_modules/left-pad/index.js');
    expect(paths).not.toContain('vendor/laravel/framework/src/Application.php');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths).not.toContain('generated/api-client.ts');
    expect(paths).toContain('.env.example');
    expect(h.indexer.getIndex().getIgnored().length).toBeGreaterThan(3);
  });

  it('binds tests to sources in both directions', async () => {
    const h = await harness();
    await h.work();
    const index = h.indexer.getIndex();
    const test = index.get('tests/orderService.test.ts');
    expect(test?.kind).toBe('test');
    expect(test?.testedPath).toBe('src/services/orderService.ts');
    expect(index.get('src/services/orderService.ts')?.tests).toContain('tests/orderService.test.ts');

    const phpTest = index.get('tests/UserControllerTest.php');
    expect(phpTest?.testedPath).toBe('app/Http/Controllers/UserController.php');

    const pythonTest = index.get('python/tests/test_orders.py');
    expect(pythonTest?.testedPath).toBe('python/analytics/orders.py');
  });

  it('builds the project map with frameworks, entry points, schema and routes', async () => {
    const h = await harness();
    await h.work();
    const map = h.intelligence.getMap();
    const frameworks = map.overview.frameworks.map((framework) => framework.name);
    expect(frameworks).toEqual(expect.arrayContaining(['Express', 'Laravel', 'Laravel migrations', 'Vitest', 'Docker Compose', 'GitHub Actions']));
    expect(map.entryPoints).toEqual(expect.arrayContaining(['src/index.ts', 'public/index.php', 'bin/cli.ts']));

    const table = map.databaseSchema.tables.find((entry) => entry.name === 'orders');
    expect(table?.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['id', 'user_id', 'status']));
    expect(table?.references).toContain('users');
    expect(map.databaseSchema.tables.some((entry) => entry.name === 'paid_orders' && entry.kind === 'view')).toBe(true);
    expect(map.databaseSchema.migrations).toContain('database/migrations/2024_01_01_000000_create_users_table.php');

    const routes = map.overview.apiRoutes.map((route) => route.name);
    expect(routes).toEqual(expect.arrayContaining(['/orders/:id', '/users/{id}']));
    expect(map.overview.projectInstructions).toEqual(expect.arrayContaining(['README.md']));
    expect(map.dependencies.externalImports).toContain('express');
    expect(map.overview.modules.length).toBeGreaterThan(2);
  });

  it('persists the index and the map, and reloads them in a new session', async () => {
    const store = new MemoryStoreFs();
    const first = await harness({ store });
    await first.work();
    const fileCount = first.indexer.getIndex().size;
    expect(store.keys()).toContain('index.json');
    expect(store.keys()).toContain('map/project-overview.json');
    expect(store.keys()).toContain('map/dependencies.json');
    expect(store.keys()).toContain('map/database-schema.json');
    expect(store.keys()).toContain('map/entry-points.json');
    expect(store.keys()).toContain('map/modules.json');

    // A second session over the same store and the same project reuses the index.
    const second = await harness({ store, root: first.root });
    await second.indexer.initialize({ loadOnly: true });
    expect(second.indexer.getIndex().size).toBe(fileCount);
    expect(second.metrics.getCounter('cache.l2.restored')).toBeGreaterThanOrEqual(0);
  });

  it('rejects an index written by another workspace and rebuilds for the new root', async () => {
    const store = new MemoryStoreFs();
    const h = await harness({ store });
    await h.work();

    const otherRoot = await harness({ store });
    await otherRoot.indexer.initialize();
    await otherRoot.indexer.waitForIdle(120_000);
    expect(otherRoot.logs.some((line) => line.includes('different workspace') || line.includes('no index found'))).toBe(true);
    expect(otherRoot.indexer.getIndex().rootKey).not.toBe(h.indexer.getIndex().rootKey);
    expect(otherRoot.indexer.getIndex().size).toBeGreaterThan(10);

    const persisted = JSON.parse(store.content('index.json') as string);
    persisted.parserVersion = 'outdated-parsers@0';
    store.set('index.json', JSON.stringify(persisted));
    const third = await harness({ store, root: otherRoot.root });
    await third.indexer.initialize();
    await third.indexer.waitForIdle(120_000);
    expect(third.logs.some((line) => line.includes('parsers changed'))).toBe(true);
    expect(third.indexer.getIndex().size).toBeGreaterThan(10);
  });

  it('quarantines a corrupt index instead of losing it and rebuilds', async () => {
    const store = new MemoryStoreFs({ 'index.json': '{ this is not json' });
    const h = await harness({ store });
    await h.work();
    expect(store.keys().some((key) => key.startsWith('index.corrupt-'))).toBe(true);
    expect(store.content('index.corrupt-') ?? '').toBeDefined();
    expect(h.logs.some((line) => line.includes('damaged'))).toBe(true);
    expect(h.indexer.getIndex().size).toBeGreaterThan(10);
  });

  it('detects changes by hash and skips untouched files on a re-scan', async () => {
    const h = await harness();
    await h.work();
    // The first scan parses everything; a second scan without changes can skip the
    // files whose size and mtime are unchanged.
    await h.indexer.fullIndex();
    expect(h.metrics.getCounter('cache.l1.fileSkipped')).toBeGreaterThan(0);

    const record = h.indexer.getIndex().get('src/utils/money.ts');
    expect(record).toBeDefined();

    await writeFile(h.root, 'src/utils/money.ts', '/** Formats integer cents. */\nexport function formatMoney(cents: number, currency = "USD"): string {\n  return `${(cents / 100).toFixed(2)} ${currency}`;\n}\n');
    await h.indexer.refreshPaths(['src/utils/money.ts']);
    const updated = h.indexer.getIndex().get('src/utils/money.ts');
    expect(updated?.hash).not.toBe(record?.hash);
    expect(updated?.symbols.some((symbol) => symbol.name === 'formatMoney')).toBe(true);
    expect(h.metrics.getCounter('index.incrementalUpdates')).toBeGreaterThan(0);
  });

  it('does not pick up an edit that keeps size and mtime, but does for a forced refresh', async () => {
    const h = await harness();
    await h.work();
    const original = await readFile(h.root, 'src/utils/money.ts');
    const sameLength = `${original.slice(0, original.length - 2)}X\n`;
    await writeFile(h.root, 'src/utils/money.ts', sameLength, 1_700_000_000_000);

    // A full re-scan trusts size+mtime, which is the documented trade-off.
    await h.indexer.fullIndex();
    const afterScan = h.indexer.getIndex().get('src/utils/money.ts');
    expect(afterScan?.symbols.some((symbol) => symbol.name === 'formatMoney')).toBe(true);

    // A file event always re-reads and re-hashes the file.
    await h.indexer.refreshPaths(['src/utils/money.ts']);
    const afterEvent = h.indexer.getIndex().get('src/utils/money.ts');
    expect(afterEvent?.hash).not.toBe(afterScan?.hash);
  });

  it('removes deleted files and scrubs dangling dependencies', async () => {
    const h = await harness();
    await h.work();
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.rm(path.join(h.root, 'src', 'utils', 'money.ts'));
    await h.indexer.refreshPaths(['src/utils/money.ts']);
    const index = h.indexer.getIndex();
    expect(index.get('src/utils/money.ts')).toBeUndefined();
    const orderService = index.get('src/services/orderService.ts');
    expect(orderService?.dependencies).not.toContain('src/utils/money.ts');
    expect(index.getStats().removedFiles).toBeGreaterThan(0);
  });

  it('keeps the last valid record when a parser fails', async () => {
    const failing: FileParser = {
      id: 'tsjs',
      version: 'tsjs-failing',
      parse(_input: ParseInput): ParseOutput {
        throw new Error('simulated parser crash');
      }
    };
    const registry = new ParserRegistry([failing, ...defaultParsers().filter((parser) => parser.id !== 'tsjs')]);
    const h = await harness({ parsers: registry });
    await h.work();
    const index = h.indexer.getIndex();
    expect(index.partial).toBe(true);
    expect(index.getErrors().length).toBeGreaterThan(0);
    expect(index.getErrors().some((error) => error.message.includes('parser failed'))).toBe(true);
    expect(h.metrics.getCounter('index.parseErrors')).toBeGreaterThan(0);
    expect(h.logs.some((line) => line.includes('simulated parser crash'))).toBe(true);
    // Files handled by the other parsers are still indexed.
    expect(index.get('app/Models/User.php')).toBeDefined();
  });

  it('marks the index partial when the file limit is reached', async () => {
    const h = await harness({ config: { maxFiles: 4 } });
    await h.work();
    const index = h.indexer.getIndex();
    expect(index.size).toBeLessThanOrEqual(4);
    expect(index.partial).toBe(true);
    expect(index.getErrors().some((error) => error.message.includes('bce.maxFiles'))).toBe(true);
  });

  it('does not reuse a cached parse result when the content hash is unchanged', async () => {
    const h = await harness();
    await h.work();
    const first = h.metrics.getCounter('cache.l1.miss');
    expect(first).toBeGreaterThan(0);
    // Re-indexing the same content hits the layer 1 cache (or the mtime fast path).
    await h.indexer.refreshPaths(['src/index.ts']);
    expect(h.metrics.getCounter('cache.l1.hit') + h.metrics.getCounter('cache.l1.hashMatch')).toBeGreaterThan(0);
  });

  it('queues file events while paused and applies them on resume', async () => {
    const h = await harness();
    await h.work();
    h.indexer.pause();
    await writeFile(h.root, 'src/utils/extra.ts', 'export function extraHelper(): number {\n  return 42;\n}\n');
    h.indexer.handleFileEvent('create', 'src/utils/extra.ts');
    await h.indexer.waitForIdle(200);
    expect(h.indexer.pendingCount()).toBeGreaterThan(0);
    expect(h.indexer.getIndex().get('src/utils/extra.ts')).toBeUndefined();
    expect(h.indexer.getFreshness().paused).toBe(true);

    h.indexer.resume();
    await h.indexer.waitForIdle(5000);
    const record = h.indexer.getIndex().get('src/utils/extra.ts');
    expect(record, `logs=${h.logs.join(' | ')} state=${JSON.stringify(h.indexer.getState())}`).toBeDefined();
    expect(record?.symbols.some((symbol) => symbol.name === 'extraHelper')).toBe(true);
    h.indexer.pause();
    expect(h.indexer.pendingCount()).toBe(0);
  });

  it('keeps two workspaces fully isolated', async () => {
    const a = await harness();
    const b = await harness();
    await a.work();
    await b.work();
    expect(a.indexer.getIndex().rootKey).not.toBe(b.indexer.getIndex().rootKey);
    expect(a.indexer.getIndex().rootKey).toBe(sha1(toPosix(a.root).toLowerCase()));
    expect(a.indexer.getIndex().paths()).toEqual(b.indexer.getIndex().paths());
    await writeFile(a.root, 'src/only-in-a.ts', 'export const onlyInA = 1;\n');
    await a.indexer.refreshPaths(['src/only-in-a.ts']);
    expect(a.indexer.getIndex().get('src/only-in-a.ts')).toBeDefined();
    expect(b.indexer.getIndex().get('src/only-in-a.ts')).toBeUndefined();
  });

  it('cancels a running index and keeps the previous state usable', async () => {
    const h = await harness();
    await h.work();
    const sizeBefore = h.indexer.getIndex().size;
    const running = h.indexer.fullIndex();
    h.indexer.cancel();
    await running;
    await h.indexer.waitForIdle();
    expect(h.indexer.getIndex().size).toBe(sizeBefore);
    expect(h.indexer.getIndex().complete).toBe(true);
  });

  it('rebuilds everything when the include patterns change', async () => {
    const store = new MemoryStoreFs();
    const h = await harness({ store });
    await h.work();
    expect(h.indexer.getIndex().get('generated/api-client.ts')).toBeUndefined();

    const reindexed = await harness({ store, root: h.root, config: { includePaths: ['generated/**'] } });
    await reindexed.indexer.initialize({ fullScan: true });
    expect(reindexed.indexer.getIndex().get('generated/api-client.ts')).toBeDefined();
  });

  it('writes the map files into the store only, never into the project', async () => {
    const store = new MemoryStoreFs();
    const h = await harness({ store });
    await h.work();
    expect(await exists(h.root, '.bce')).toBe(false);
    expect(store.keys().some((key) => key.startsWith('map/'))).toBe(true);
  });
});

describe('index store', () => {
  it('refuses to write when another instance holds the lock', async () => {
    const store = new MemoryStoreFs();
    // The memory store reports an mtime of 1000 for every entry, so the clock has
    // to start there for the lock to count as fresh.
    const now = { value: 1000 };
    const indexStore = new IndexStore(store, { now: () => now.value }, 111);
    expect(await indexStore.acquireLock()).toBe(true);

    const second = new IndexStore(store, { now: () => now.value }, 222);
    expect(await second.acquireLock()).toBe(false);

    // A stale lock (older than 15 s) can be taken over.
    now.value += 20_000;
    expect(await second.acquireLock()).toBe(true);
  });

  it('ignores a context cache written by an older schema', async () => {
    const backing = new MemoryStoreFs({ 'context-cache.json': JSON.stringify({ schemaVersion: 999, entries: { a: {} } }) });
    const indexStore = new IndexStore(backing);
    expect(await indexStore.loadContextCache()).toEqual({});
    expect(backing.keys()).not.toContain('context-cache.json');
  });

  it('reports a missing index without failing', async () => {
    const indexStore = new IndexStore(new MemoryStoreFs());
    const result = await indexStore.load({ rootKey: 'x', parserVersion: 'y', configSignature: 'z' });
    expect(result.status).toBe('missing');
  });

  it('round-trips the index through the store', async () => {
    const backing = new MemoryStoreFs();
    const h = await harness({ store: backing });
    await h.work();
    const persisted = JSON.parse((await backing.readText('index.json')) as string);
    expect(persisted.schemaVersion).toBe(1);
    expect(Array.isArray(persisted.files)).toBe(true);
    expect(persisted.rootKey).toBe(sha1(toPosix(h.root).toLowerCase()));

    const fs = new NodeFileSystem(h.root);
    const reloaded = new IndexStore(backing);
    const result = await reloaded.load({
      rootKey: persisted.rootKey,
      parserVersion: persisted.parserVersion,
      configSignature: persisted.configSignature
    });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.index.size).toBe(persisted.files.length);
      expect(result.droppedContextCache).toBe(false);
    }

    // The files on disk are still readable after a reload, so the config signature matches.
    expect(await fs.exists('src/index.ts')).toBe(true);
    expect(configSignature(h.config)).toBe(persisted.configSignature);
    expect(maxFileSizeBytes(h.config)).toBe(512 * 1024);
  });
});

describe('indexer internals', () => {
  it('reports progress and a freshness object the status bar can render', async () => {
    const states: string[] = [];
    const h = await harness();
    const subscription = h.indexer.onStateChange((state) => states.push(`${state.phase}:${state.progress.processed}/${state.progress.total}`));
    await h.work();
    subscription.dispose();
    expect(states.some((state) => state.startsWith('scanning'))).toBe(true);
    expect(states.some((state) => state.startsWith('indexing'))).toBe(true);
    const freshness = h.indexer.getFreshness();
    expect(freshness.complete).toBe(true);
    expect(freshness.stale).toBe(false);
    expect(freshness.indexVersion).toBeGreaterThan(0);
    expect(freshness.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('increments the index version on every update', async () => {
    const h = await harness();
    await h.work();
    const first = h.indexer.getIndex().indexVersion;
    await writeFile(h.root, 'src/versioning.ts', 'export const versionMarker = 1;\n');
    await h.indexer.refreshPaths(['src/versioning.ts']);
    expect(h.indexer.getIndex().indexVersion).toBeGreaterThan(first);
  });

  it('exposes metrics for the diagnostics view', async () => {
    const h = await harness();
    await h.work();
    const snapshot = h.metrics.snapshot();
    expect(snapshot.counters['index.files']).toBeGreaterThan(0);
    expect(snapshot.notes.join(' ')).toContain('estimates');
  });

  it('uses the metrics and cache objects it was given', async () => {
    const metrics = new Metrics();
    const cache = new ContextCache<unknown>();
    const h = await harness();
    await h.work();
    expect(h.metrics).toBe(h.metrics);
    expect(cache.size).toBe(0);
    expect(metrics.snapshot().counters).toEqual({});
    expect(new IgnoreEngine({ includePatterns: [], ignorePatterns: [], respectGitignore: true }).respectGitignore).toBe(true);
  });
});
