import { afterEach, describe, expect, it } from 'vitest';
import { ContextCache } from '../src/core/cache/contextCache';
import { createHarness, Harness } from './support/harness';
import { writeFile } from './support/tempProject';

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

describe('layer 2 context cache', () => {
  it('returns a cached payload while its dependencies are unchanged', () => {
    const cache = new ContextCache<{ value: string }>();
    const key = cache.makeKey({ tool: 'bce_find_context', indexVersion: 1, configSignature: 'cfg', query: 'orders' });
    cache.set(key, { 'src/a.ts': 'hash-a' }, { value: 'cached' });
    expect(cache.get(key, (path) => (path === 'src/a.ts' ? 'hash-a' : undefined))).toEqual({ value: 'cached' });
    expect(cache.stats().hits).toBe(1);
  });

  it('invalidates an entry when a dependency hash changes', () => {
    const cache = new ContextCache<number>();
    const key = cache.makeKey({ tool: 'bce_find_context', indexVersion: 1, configSignature: 'cfg', query: 'orders' });
    cache.set(key, { 'src/a.ts': 'hash-a' }, 1);
    expect(cache.get(key, () => 'hash-b')).toBeUndefined();
    expect(cache.stats().invalidations).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('drops entries older than the maximum age', () => {
    const now = { value: 0 };
    const cache = new ContextCache<string>({}, 10, { now: () => now.value });
    const key = cache.makeKey({ tool: 't', indexVersion: 1, configSignature: 'c', query: 'q' });
    cache.set(key, {}, 'value');
    now.value = 31 * 60 * 1000;
    expect(cache.get(key, () => undefined)).toBeUndefined();
  });

  it('invalidates only the entries that depend on a changed path', () => {
    const cache = new ContextCache<string>();
    cache.set('a', { 'src/a.ts': '1' }, 'entry-a');
    cache.set('b', { 'src/b.ts': '1' }, 'entry-b');
    expect(cache.invalidatePaths(['src/a.ts'])).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get('b', () => '1')).toBe('entry-b');
  });

  it('prunes the oldest entries when the limit is exceeded', () => {
    const now = { value: 0 };
    const cache = new ContextCache<string>({}, 2, { now: () => now.value });
    cache.set('a', {}, 'a');
    now.value += 10;
    cache.set('b', {}, 'b');
    now.value += 10;
    cache.set('c', {}, 'c');
    expect(cache.size).toBe(2);
    expect(cache.get('a', () => undefined)).toBeUndefined();
    expect(cache.get('c', () => undefined)).toBe('c');
  });

  it('produces stable keys for identical requests and different keys otherwise', () => {
    const cache = new ContextCache<number>();
    const base = { tool: 'bce_find_context', indexVersion: 3, configSignature: 'c', query: 'orders' };
    expect(cache.makeKey(base)).toBe(cache.makeKey({ ...base }));
    expect(cache.makeKey(base)).not.toBe(cache.makeKey({ ...base, query: 'users' }));
    expect(cache.makeKey(base)).not.toBe(cache.makeKey({ ...base, indexVersion: 4 }));
    expect(cache.makeKey(base)).not.toBe(cache.makeKey({ ...base, options: { scope: 'src' } }));
  });
});

describe('cache integration with the index', () => {
  it('serves a repeated search from the cache and recomputes after a file change', async () => {
    const h = await harness();
    await h.work();
    const options = {
      query: 'OrderService refund',
      maxTokens: 800,
      includeTests: true,
      includeSnippets: false,
      maxResults: 5,
      snippetLines: 0
    };

    const first = await h.intelligence.retrieveCached(options);
    expect(first.fromCache).toBe(false);
    const second = await h.intelligence.retrieveCached(options);
    expect(second.fromCache).toBe(true);
    expect(h.metrics.getCounter('cache.l2.hit')).toBeGreaterThan(0);

    await writeFile(h.root, 'src/services/orderService.ts', 'export class OrderService {\n  async refund(): Promise<void> {}\n}\n');
    await h.indexer.refreshPaths(['src/services/orderService.ts']);
    const third = await h.intelligence.retrieveCached(options);
    expect(third.fromCache).toBe(false);
  });

  it('reuses parsed results for identical file contents (layer 1)', async () => {
    const h = await harness();
    await h.work();
    const shared = 'export function sharedHelper(): number {\n  return 7;\n}\n';
    await writeFile(h.root, 'src/shared/one.ts', shared);
    await writeFile(h.root, 'src/shared/two.ts', shared);
    const before = h.metrics.getCounter('cache.l1.hit');
    await h.indexer.refreshPaths(['src/shared/one.ts', 'src/shared/two.ts']);
    expect(h.metrics.getCounter('cache.l1.hit')).toBeGreaterThan(before);
    expect(h.indexer.getIndex().get('src/shared/two.ts')?.symbols.some((symbol) => symbol.name === 'sharedHelper')).toBe(true);
  });

  it('clears both cache layers on rebuild', async () => {
    const h = await harness();
    await h.work();
    await h.intelligence.retrieveCached({
      query: 'money',
      maxTokens: 500,
      includeTests: true,
      includeSnippets: false,
      maxResults: 3,
      snippetLines: 0
    });
    expect(h.contextCache.size).toBeGreaterThan(0);
    await h.indexer.rebuild();
    expect(h.contextCache.size).toBe(0);
    expect(h.metrics.getCounter('cache.cleared')).toBeGreaterThan(0);
  });
});
