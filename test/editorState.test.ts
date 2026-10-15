import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, FakeDocuments, Harness } from './support/harness';
import { runFileContext, runFindContext, runStatus } from '../src/core/tools/handlers';
import { hashContent } from '../src/core/util/hash';
import { readFile, writeFile } from './support/tempProject';

const harnesses: Harness[] = [];

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

const EDITED_ORDER_SERVICE = `import { formatMoney } from '../utils/money';

export class OrderService {
  async refundWithReason(id: string, reason: string): Promise<string> {
    return \`\${id}:\${reason}\`;
  }
}
`;

describe('unsaved editor content wins over disk content', () => {
  it('returns the editor buffer and re-parses it so new symbols resolve', async () => {
    const documents = new FakeDocuments();
    const h = await harness({ documents });
    await h.work();

    // The disk copy still has refund(); the editor buffer renamed it.
    documents.set('src/services/orderService.ts', EDITED_ORDER_SERVICE, 7);
    await writeFile(h.root, 'src/services/orderService.ts', await readFile(h.root, 'src/services/orderService.ts'));

    const edited = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'refundWithReason' });
    expect(edited.text).toContain('UNSAVED editor buffer');
    expect(edited.text).toContain('refundWithReason');

    // The stale symbol from disk must not be served as if it still existed.
    const stale = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'refund' });
    expect(stale.text).toContain('not found');

    // The file on disk is still the old one, so symbol lookups there still work.
    documents.save('src/services/orderService.ts');
    const diskView = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'refund' });
    expect(diskView.text).not.toContain('UNSAVED editor buffer');
    expect(diskView.text).toContain('refund');
  });

  it('marks snippets from unsaved buffers and warns about shifted line numbers', async () => {
    const documents = new FakeDocuments();
    const h = await harness({ documents });
    await h.work();
    documents.set('src/utils/money.ts', '/** Editor-only version. */\nexport function formatMoneyV2(cents: number): string {\n  return String(cents);\n}\n', 3);

    const payload = await runFindContext(h.intelligence, { query: 'formatMoney', includeSnippets: true });
    expect(payload.text).toContain('UNSAVED editor content');
    expect(payload.text).toContain('formatMoneyV2');
    expect(payload.text).toContain('unsaved changes');
  });

  it('keeps unsaved content out of the persisted index', async () => {
    const documents = new FakeDocuments();
    const h = await harness({ documents });
    await h.work();
    const diskText = await readFile(h.root, 'src/services/orderService.ts');
    const record = h.indexer.getIndex().get('src/services/orderService.ts');
    expect(record?.hash).toBe(hashContent(diskText));

    documents.set('src/services/orderService.ts', EDITED_ORDER_SERVICE, 2);
    await h.intelligence.readFile('src/services/orderService.ts');
    await h.indexer.fullIndex();

    const after = h.indexer.getIndex().get('src/services/orderService.ts');
    expect(after?.hash).toBe(hashContent(await readFile(h.root, 'src/services/orderService.ts')));
    expect(after?.symbols.some((symbol) => symbol.name === 'refundWithReason')).toBe(false);
    expect(after?.symbols.some((symbol) => symbol.name === 'refund')).toBe(true);
  });

  it('invalidates the context cache when an unsaved buffer changes', async () => {
    const documents = new FakeDocuments();
    const h = await harness({ documents });
    await h.work();
    const options = {
      query: 'formatMoney',
      maxTokens: 800,
      includeTests: true,
      includeSnippets: true,
      maxResults: 5,
      snippetLines: 6
    };

    await h.intelligence.retrieveCached(options);
    const cached = await h.intelligence.retrieveCached(options);
    expect(cached.fromCache).toBe(true);

    documents.set('src/utils/money.ts', 'export function formatMoneyThird(): void {}\n', 1);
    const afterDirty = await h.intelligence.retrieveCached(options);
    expect(afterDirty.fromCache).toBe(false);

    const again = await h.intelligence.retrieveCached(options);
    expect(again.fromCache).toBe(true);
    documents.set('src/utils/money.ts', 'export function formatMoneyFourth(): void {}\n', 2);
    expect((await h.intelligence.retrieveCached(options)).fromCache).toBe(false);
  });

  it('reports unsaved editor state in the status output', async () => {
    const documents = new FakeDocuments();
    const h = await harness({ documents });
    await h.work();
    const clean = await runStatus(h.intelligence, {});
    expect(clean.text).toContain('unsaved changes: none');

    documents.set('src/utils/money.ts', 'export const changed = 1;\n', 1);
    const dirty = await runStatus(h.intelligence, { verbose: true });
    expect(dirty.text).toContain('unsaved changes: 1 open file(s)');
    expect(dirty.text).toContain('src/utils/money.ts');
    expect(dirty.text).toContain('never written into the index');
    expect(h.intelligence.dirtyFingerprint()).not.toBe('clean');
    expect(h.intelligence.dirtyDocuments()).toHaveLength(1);
  });

  it('works without an editor state provider', async () => {
    const h = await harness();
    await h.work();
    expect(h.intelligence.dirtyDocuments()).toEqual([]);
    expect(h.intelligence.dirtyFingerprint()).toBe('clean');
    const payload = await runFileContext(h.intelligence, { path: 'src/utils/money.ts' });
    expect(payload.text).toContain('file: src/utils/money.ts');
    expect(payload.text).not.toContain('UNSAVED');
  });
});

describe('indexing stays responsive', () => {
  it('hands the event loop back while parsing many files', async () => {
    const h = await harness();
    await h.work();
    expect(h.metrics.getCounter('index.yields')).toBeGreaterThan(0);
  });

  it('re-queues a change that arrives while the same file is being indexed', async () => {
    const h = await harness();
    await h.work();
    const before = h.indexer.getIndex().get('src/utils/money.ts');
    await writeFile(h.root, 'src/utils/money.ts', 'export function moneyChangedDuringIndexing(): number {\n  return 1;\n}\n');

    const running = h.indexer.fullIndex();
    h.indexer.handleFileEvent('change', 'src/utils/money.ts');
    await running;
    await h.indexer.waitForIdle(10000);

    const after = h.indexer.getIndex().get('src/utils/money.ts');
    expect(after?.hash).not.toBe(before?.hash);
    expect(after?.symbols.some((symbol) => symbol.name === 'moneyChangedDuringIndexing')).toBe(true);
  });

  it('coalesces a burst of events for the same path into one update', async () => {
    const h = await harness();
    await h.work();
    await writeFile(h.root, 'src/utils/burst.ts', 'export function burstA(): number {\n  return 0;\n}\n');
    for (let index = 0; index < 12; index += 1) {
      await writeFile(h.root, 'src/utils/burst.ts', `export function burst${index}(): number {\n  return ${index};\n}\n`);
      h.indexer.handleFileEvent('change', 'src/utils/burst.ts');
    }
    await h.indexer.waitForIdle(10000);
    const record = h.indexer.getIndex().get('src/utils/burst.ts');
    expect(record?.symbols.map((symbol) => symbol.name)).toContain('burst11');
    expect(h.metrics.getCounter('index.fileEvents.change')).toBe(12);
    // One debounced pass, not twelve: incremental updates stay far below the event count.
    expect(h.metrics.getCounter('index.incrementalUpdates')).toBeLessThanOrEqual(3);
  });
});
