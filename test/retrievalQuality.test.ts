import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { runFindContext } from '../src/core/tools/handlers';
import { computeQuality, renderUsageReport as renderReport, UsageLedger } from '../src/core/diagnostics/usageLedger';
import { estimateNaiveBaseline } from '../src/core/benchmark/baseline';
import { MemoryStoreFs } from './support/memoryFs';

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

describe('two-phase retrieval', () => {
  it('returns targets without reading any code body in symbolsOnly mode', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFindContext(h.intelligence, { query: 'OrderService refund', symbolsOnly: true });
    expect(payload.text).toContain('mode: symbolsOnly');
    // The whole point: a phase-one answer must not contain a code block.
    expect(payload.text).not.toContain('   code:');
    expect(payload.quality?.hits).toBeGreaterThan(0);
  });

  it('ranks more candidates in symbolsOnly mode than it could afford with snippets', async () => {
    const h = await harness();
    await h.work();
    const withSnippets = await runFindContext(h.intelligence, { query: 'user order service refund', includeSnippets: true });
    const indexOnly = await runFindContext(h.intelligence, { query: 'user order service refund', symbolsOnly: true });
    expect(indexOnly.quality!.hits).toBeGreaterThanOrEqual(withSnippets.quality!.hits);
    expect(indexOnly.estimatedTokens).toBeLessThan(withSnippets.estimatedTokens);
  });

  it('reports the mode and index scope in the snippet answer too', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFindContext(h.intelligence, { query: 'OrderService refund' });
    expect(payload.text).toContain('index scope:');
    expect(payload.text).toContain('coverage:');
    expect(payload.text).not.toContain('mode: symbolsOnly');
  });

  it('warns that an empty result is not proof of absence when the graph is incomplete', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFindContext(h.intelligence, { query: 'zzzz_no_such_symbol_zzzz' });
    expect(payload.quality?.hits).toBe(0);
    // The fixture has unresolved imports in the PHP vendor tree, so the caveat must show.
    expect(payload.text).toMatch(/empty result here is NOT proof of absence|No indexed file matched/);
  });
});

describe('honest usage numbers', () => {
  /** Mirrors what the host does after a tool call, so the ledger has real records. */
  async function callAndRecord(h: Harness, query: string): Promise<void> {
    const payload = await runFindContext(h.intelligence, { query });
    const baseline = estimateNaiveBaseline(h.intelligence.index, query);
    h.usage.record({
      tool: 'bce_find_context',
      label: query,
      returnedTokens: payload.estimatedTokens,
      characters: payload.text.length,
      baselineTokens: baseline.estimatedTokens,
      baselineFiles: baseline.files,
      durationMs: 1,
      hits: payload.quality?.hits,
      truncated: payload.quality?.truncated,
      dirty: payload.quality?.dirty
    });
  }

  it('reports a range instead of a single authoritative saving', async () => {
    const h = await harness();
    await h.work();
    // Queries with deliberately different baseline footprints: the first matches a
    // single service file, the second names words that appear all over the fixture.
    await callAndRecord(h, 'refund');
    await callAndRecord(h, 'user order service refund payment token model route');
    await h.usage.flush();
    const summary = h.usage.summary();
    const report = renderReport(summary);
    expect(summary.totals.callsWithBaseline).toBe(2);
    expect(report).toContain('**upper bound**');
    // Two different baselines must produce a real spread, not one number.
    expect(summary.totals.baselineTokensLowerBound).not.toBe(summary.totals.baselineTokens);
    expect(report).toContain('naive alternative, low end');
    expect(report).toMatch(/estimated tokens avoided \| ~\d+ to ~\d+/);
    expect(report).toContain('share of the upper bound actually returned');
  });

  it('states that token savings are not a quality signal', async () => {
    const h = await harness();
    await h.work();
    await callAndRecord(h, 'OrderService refund');
    await h.usage.flush();
    const report = renderReport(h.usage.summary());
    expect(report).toContain('Token savings are not a quality signal');
    expect(report).toContain('**range**');
  });

  it('counts empty and productive calls so a saving can be judged', async () => {
    const h = await harness();
    await h.work();
    await callAndRecord(h, 'OrderService refund');
    await callAndRecord(h, 'zzzz_no_such_symbol_zzzz');
    await h.usage.flush();
    const summary = h.usage.summary();
    expect(summary.quality?.empty).toBe(1);
    expect(summary.quality?.productive).toBe(1);
    expect(renderReport(summary)).toContain('## Retrieval quality this session');
  });

  it('recomputes quality for a summary that was built without it', async () => {
    const store = new MemoryStoreFs();
    const ledger = await UsageLedger.load({ store, rootName: 'x', enabled: () => false });
    ledger.record({ tool: 'bce_find_context', returnedTokens: 10, characters: 40, durationMs: 1, hits: 0 });
    ledger.record({ tool: 'bce_find_context', returnedTokens: 10, characters: 40, durationMs: 1, hits: 3, truncated: true });
    const quality = computeQuality(ledger.summary().recent, ledger.totals());
    expect(quality.empty).toBe(1);
    expect(quality.productive).toBe(1);
    expect(quality.truncated).toBe(1);
  });
});
