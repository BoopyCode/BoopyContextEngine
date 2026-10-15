import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { tokenize } from '../src/core/retrieve/contextRetriever';
import { defaultTokenEstimator, TokenBudget } from '../src/core/util/tokens';
import { mergeRanges, renderSnippet } from '../src/core/retrieve/snippets';

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

function options(partial: Partial<Parameters<Harness['intelligence']['retrieve']>[0]> = {}) {
  return {
    query: 'placeholder',
    maxTokens: 1200,
    includeTests: true,
    includeSnippets: true,
    maxResults: 8,
    snippetLines: 6,
    ...partial
  };
}

describe('query tokenization', () => {
  it('splits identifiers and drops stop words', () => {
    expect(tokenize('where is the OrderService refund code')).toEqual(expect.arrayContaining(['orderservice', 'order', 'service', 'refund']));
    expect(tokenize('the and of')).toEqual([]);
  });

  it('caps the number of terms', () => {
    const tokens = tokenize(Array.from({ length: 60 }, (_, index) => `term${index}`).join(' '));
    expect(tokens.length).toBeLessThanOrEqual(24);
  });
});

describe('token budget', () => {
  it('stops adding text when the budget is exhausted', () => {
    const budget = new TokenBudget(30);
    expect(budget.tryAdd('a'.repeat(40))).toBe(true);
    expect(budget.tryAdd('b'.repeat(200))).toBe(false);
    expect(budget.truncated).toBe(true);
    expect(budget.used).toBeLessThanOrEqual(30);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it('labels its estimates as estimates', () => {
    expect(defaultTokenEstimator.exact).toBe(false);
    expect(defaultTokenEstimator.method).toContain('heuristic');
    expect(defaultTokenEstimator.estimate('')).toBe(0);
    expect(defaultTokenEstimator.estimate('const value = computeSomething(a, b);')).toBeGreaterThan(3);
  });

  it('merges overlapping line ranges and renders them with line numbers', () => {
    expect(mergeRanges([{ start: 10, end: 12 }, { start: 14, end: 20 }, { start: 40, end: 41 }], 100)).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 41 }
    ]);
    const snippet = renderSnippet('a\nb\nc\nd\ne\n', [{ start: 2, end: 4 }], 10);
    expect(snippet.text).toContain('2| b');
    expect(snippet.ranges).toEqual([{ start: 2, end: 4 }]);
  });
});

describe('context retrieval', () => {
  it('ranks the file that defines the queried symbol first', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'OrderService refund logic' }));
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items[0].path).toBe('src/services/orderService.ts');
    expect(bundle.items[0].reasons.join(' ')).toContain('OrderService');
    expect(bundle.items[0].symbols.some((symbol) => symbol.name === 'OrderService')).toBe(true);
  });

  it('finds database objects for schema queries', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'orders table schema migration', includeSnippets: false }));
    const paths = bundle.items.map((item) => item.path);
    expect(paths.some((path) => path === 'database/schema.sql' || path.includes('migrations'))).toBe(true);
  });

  it('honors the scope filter', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'service', scope: 'src/services' }));
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items.every((item) => item.path.startsWith('src/services/'))).toBe(true);
  });

  it('can exclude test files', async () => {
    const h = await harness();
    await h.work();
    const withTests = await h.intelligence.retrieve(options({ query: 'OrderService refund' }));
    const withoutTests = await h.intelligence.retrieve(options({ query: 'OrderService refund', includeTests: false }));
    expect(withoutTests.items.every((item) => item.kind !== 'test')).toBe(true);
    expect(withTests.candidates).toBeGreaterThan(withoutTests.candidates);
  });

  it('respects the token budget and reports truncation', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'order user service money report schema route', maxTokens: 220 }));
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(220);
    expect(bundle.truncated).toBe(true);
    expect(bundle.warnings.join(' ')).toContain('token budget');
  });

  it('omits snippets when they are not requested', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'OrderService', includeSnippets: false }));
    expect(bundle.items.every((item) => item.snippet === undefined)).toBe(true);
  });

  it('includes a numbered snippet for the best hit', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'formatMoney', includeSnippets: true }));
    const item = bundle.items.find((entry) => entry.path === 'src/utils/money.ts');
    expect(item?.snippet).toBeDefined();
    expect(item?.snippet).toContain('|');
  });

  it('explains an empty result instead of guessing', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({ query: 'zzqqxxyyvv' }));
    expect(bundle.items.length).toBe(0);
    expect(bundle.warnings.length).toBeGreaterThan(0);
  });

  it('boosts recently changed files when git information is available', async () => {
    const h = await harness({
      gitRunner: {
        async run(_command, args) {
          if (args.includes('--is-inside-work-tree')) {
            return { code: 0, stdout: 'true\n', stderr: '' };
          }
          if (args.includes('--abbrev-ref')) {
            return { code: 0, stdout: 'main\n', stderr: '' };
          }
          return { code: 0, stdout: '__commit__abc\nsrc/utils/money.ts\n', stderr: '' };
        }
      }
    });
    await h.work();
    const recent = await h.intelligence.recentChanges();
    expect(recent.available).toBe(true);
    expect(recent.changedPaths).toContain('src/utils/money.ts');
    const bundle = await h.intelligence.retrieve(options({ query: 'recently changed money helper', recentPaths: recent.changedPaths, includeSnippets: false }));
    const item = bundle.items.find((entry) => entry.path === 'src/utils/money.ts');
    expect(item?.reasons.join(' ')).toContain('changed recently');
  });

  it('reports git as unavailable when no runner is configured', async () => {
    const h = await harness();
    await h.work();
    const recent = await h.intelligence.recentChanges();
    expect(recent.available).toBe(false);
    expect(recent.reason).toBeDefined();
  });

  it('returns suggestions when a symbol path is wrong', async () => {
    const h = await harness();
    await h.work();
    const result = await h.intelligence.renderFileContext('src/services/orderService.ts', { symbol: 'refun' }, 2000);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('refund');
  });

  it('never exceeds the budget for a file slice', async () => {
    const h = await harness();
    await h.work();
    const result = await h.intelligence.renderFileContext('src/services/orderService.ts', { startLine: 1, endLine: 60 }, 200);
    expect(result.estimatedTokens).toBeLessThanOrEqual(200 + 50);
  });
});
