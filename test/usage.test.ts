import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { computeTotals, parseUsageLog, renderUsageReport, USAGE_LOG_FILE, UsageLedger } from '../src/core/diagnostics/usageLedger';
import { estimateUsageSavings } from '../src/core/diagnostics/savings';
import { runFindContext, runFileContext, runStatus } from '../src/core/tools/handlers';
import { MemoryStoreFs } from './support/memoryFs';

let h: Harness;

beforeEach(async () => {
  h = await createHarness({ memoryStore: true });
});

afterEach(async () => {
  await h.cleanup();
});

describe('usage ledger', () => {
  it('appends one line per record and rolls the totals up', async () => {
    h.usage.record({ tool: 'bce_find_context', label: 'order refund', returnedTokens: 400, characters: 1600, baselineTokens: 5000, durationMs: 12 });
    h.usage.record({ tool: 'bce_find_context', label: 'order refund', returnedTokens: 300, characters: 1200, baselineTokens: 2000, durationMs: 8 });
    h.usage.record({ tool: 'bce_get_status', returnedTokens: 50, characters: 200, durationMs: 3 });
    await h.usage.flush();

    const totals = h.usage.totals();
    expect(totals.calls).toBe(3);
    expect(totals.returnedTokens).toBe(750);
    expect(totals.baselineTokens).toBe(7000);
    expect(totals.callsWithBaseline).toBe(2);
    expect(totals.savedTokens).toBe(6250);
    expect(totals.savedPercent).toBeGreaterThan(89);
    expect(totals.firstAt).toBeGreaterThan(0);
    expect(totals.lastAt).toBeGreaterThanOrEqual(totals.firstAt);

    const lines = (h.memoryStore?.content(USAGE_LOG_FILE) ?? '').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).tool).toBe('bce_find_context');
  });

  it('counts a call without a baseline but keeps it out of the saved percentage', () => {
    const totals = computeTotals([
      { at: 1, tool: 'bce_find_context', returnedTokens: 100, characters: 400, baselineTokens: 10000, durationMs: 5 },
      { at: 2, tool: 'bce_get_status', returnedTokens: 50, characters: 200, durationMs: 2 },
      { at: 3, tool: 'bce_find_context', returnedTokens: 0, characters: 0, durationMs: 1, error: true }
    ]);
    expect(totals.calls).toBe(3);
    expect(totals.errors).toBe(1);
    expect(totals.callsWithBaseline).toBe(1);
    expect(totals.savedPercent).toBe(98.5);
  });

  it('reloads the history from disk and survives damaged lines', async () => {
    h.usage.record({ tool: 'bce_find_context', returnedTokens: 120, characters: 480, baselineTokens: 900, durationMs: 4 });
    await h.usage.flush();

    const store = new MemoryStoreFs({
      [USAGE_LOG_FILE]: `{ not json\n${h.memoryStore?.content(USAGE_LOG_FILE) ?? ''}`
    });
    const reloaded = await UsageLedger.load({ store, rootName: 'fixture', enabled: () => true });
    expect(reloaded.size).toBe(1);
    expect(reloaded.totals().returnedTokens).toBe(120);
  });

  it('keeps reporting in memory when logging is turned off', async () => {
    const store = new MemoryStoreFs();
    const ledger = await UsageLedger.load({ store, rootName: 'fixture', enabled: () => false });
    ledger.record({ tool: 'bce_find_context', returnedTokens: 10, characters: 40, durationMs: 1 });
    await ledger.flush();

    expect(ledger.totals().calls).toBe(1);
    expect(ledger.isPersisted).toBe(false);
    expect(store.content(USAGE_LOG_FILE)).toBeUndefined();
  });

  it('clears the log on request', async () => {
    h.usage.record({ tool: 'bce_find_context', returnedTokens: 10, characters: 40, durationMs: 1 });
    await h.usage.flush();
    await h.usage.clear();

    expect(h.usage.size).toBe(0);
    expect(h.memoryStore?.content(USAGE_LOG_FILE)).toBeUndefined();
  });

  it('ignores unknown fields when parsing a log', () => {
    const records = parseUsageLog('{"at":1,"tool":"bce_find_context","returnedTokens":"nonsense","extra":true}\n');
    expect(records).toHaveLength(1);
    expect(records[0].returnedTokens).toBe(0);
    expect(records[0].characters).toBe(0);
  });
});

describe('usage savings estimation', () => {
  it('gives find_context a naive baseline and file_context a whole file baseline', async () => {
    await h.work();

    const search = estimateUsageSavings(h.intelligence, 'bce_find_context', { query: 'OrderService refund' });
    expect(search.label).toBe('OrderService refund');
    expect(search.baselineTokens).toBeGreaterThan(0);
    expect(search.baselineFiles).toBeGreaterThan(0);
    expect(search.candidateFiles).toBe(h.indexer.getIndex().size);

    const file = estimateUsageSavings(h.intelligence, 'bce_get_file_context', { path: 'src/services/orderService.ts', symbol: 'refund' });
    expect(file.label).toBe('src/services/orderService.ts#refund');
    expect(file.baselineTokens).toBeGreaterThan(0);
    expect(file.baselineFiles).toBe(1);
  });

  it('does not invent a baseline for tools that have no naive equivalent', () => {
    const impact = estimateUsageSavings(h.intelligence, 'bce_explain_impact', { symbol: 'OrderService' });
    expect(impact.label).toBe('OrderService');
    expect(impact.baselineTokens).toBeUndefined();

    const overview = estimateUsageSavings(h.intelligence, 'bce_get_project_overview', { focus: 'database' });
    expect(overview.label).toBe('focus: database');
    expect(overview.baselineTokens).toBeUndefined();
  });
});

describe('usage reporting', () => {
  it('sums what the handlers returned and shows it in the status output', async () => {
    await h.work();

    const search = await runFindContext(h.intelligence, { query: 'OrderService refund', maxTokens: 200, includeTests: true, includeSnippets: false });
    const file = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'refund' });
    expect(search.estimatedTokens, search.text.slice(0, 200)).toBeGreaterThan(0);
    expect(file.estimatedTokens, file.text.slice(0, 300)).toBeGreaterThan(0);

    // The host adapter records every call; here the entries are supplied directly.
    for (const [tool, payload, input] of [
      ['bce_find_context', search, { query: 'OrderService refund' }],
      ['bce_get_file_context', file, { path: 'src/services/orderService.ts', symbol: 'refund' }]
    ] as const) {
      const savings = estimateUsageSavings(h.intelligence, tool, input);
      h.usage.record({
        tool,
        label: savings.label,
        returnedTokens: payload.estimatedTokens,
        characters: payload.text.length,
        baselineTokens: savings.baselineTokens,
        durationMs: 5
      });
    }
    await h.usage.flush();

    const totals = h.usage.totals();
    expect(totals.callsWithBaseline).toBe(2);
    // A budgeted search plus one symbol body must be smaller than reading the candidates.
    expect(totals.savedTokens, JSON.stringify({ returned: totals.returnedTokens, baseline: totals.baselineTokens })).toBeGreaterThan(0);
    expect((h.memoryStore?.content(USAGE_LOG_FILE) ?? '').trim().split('\n')).toHaveLength(2);

    const status = await runStatus(h.intelligence, { verbose: true });
    expect(status.text).toContain('estimated context avoided');
    expect(status.text).toContain(`saved in ${USAGE_LOG_FILE}`);
  });

  it('renders a report that states its own limits', () => {
    const ledgerReport = renderUsageReport({
      rootName: 'fixture',
      logFile: USAGE_LOG_FILE,
      persisted: true,
      updatedAt: 1,
      totals: computeTotals([
        { at: 1, tool: 'bce_find_context', label: 'order refund', returnedTokens: 400, characters: 1600, baselineTokens: 5000, durationMs: 12 }
      ]),
      perTool: [
        {
          tool: 'bce_find_context',
          totals: computeTotals([
            { at: 1, tool: 'bce_find_context', label: 'order refund', returnedTokens: 400, characters: 1600, baselineTokens: 5000, durationMs: 12 }
          ])
        }
      ],
      recent: [{ at: 1, tool: 'bce_find_context', label: 'order | refund', returnedTokens: 400, characters: 1600, baselineTokens: 5000, durationMs: 12 }]
    });

    expect(ledgerReport).toContain('# BCE usage log - fixture');
    expect(ledgerReport).toContain('| estimated tokens avoided | ~4600 (92% smaller) |');
    expect(ledgerReport).toContain('local estimates');
    expect(ledgerReport).toContain('order \\| refund');
    expect(ledgerReport).not.toContain('No `bce_*` tool call has been logged');
  });

  it('shows why a failed call failed', () => {
    const record = { at: 1, tool: 'bce_get_project_overview', returnedTokens: 0, characters: 0, durationMs: 1, error: true, reason: 'boom' };
    const failed = renderUsageReport({
      rootName: 'fixture',
      logFile: USAGE_LOG_FILE,
      persisted: true,
      updatedAt: 1,
      totals: computeTotals([record]),
      perTool: [{ tool: 'bce_get_project_overview', totals: computeTotals([record]) }],
      recent: [record]
    });

    expect(failed).toContain('| tool calls | 1 (1 failed) |');
    expect(failed).toContain('FAILED: boom');
  });

  it('keeps the failure reason when the log is read back from disk', () => {
    const records = parseUsageLog('{"at":1,"tool":"bce_get_status","returnedTokens":0,"characters":0,"durationMs":2,"error":true,"reason":"index missing"}\n');

    expect(records).toHaveLength(1);
    expect(records[0].error).toBe(true);
    expect(records[0].reason).toBe('index missing');
  });

  it('explains an empty report instead of only printing zeroes', () => {
    const empty = renderUsageReport({
      rootName: 'fixture',
      logFile: USAGE_LOG_FILE,
      logLocation: `C:\\bce\\${USAGE_LOG_FILE}`,
      persisted: true,
      updatedAt: 1,
      totals: computeTotals([]),
      perTool: [],
      recent: []
    });

    expect(empty).toContain('entries: 0');
    expect(empty).toContain('No `bce_*` tool call has been logged for this workspace yet');
    expect(empty).toContain(`log file: C:\\bce\\${USAGE_LOG_FILE}`);
    expect(empty).not.toContain('## Per tool');
    expect(empty).not.toContain('## Recent calls');
  });
});
