import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import {
  runExplainImpact,
  runFileContext,
  runFindContext,
  runProjectOverview,
  runRelatedTests,
  runStatus
} from '../src/core/tools/handlers';
import {
  validateFileContextInput,
  validateFindContextInput,
  validateImpactInput,
  validateProjectOverviewInput,
  validateRelatedTestsInput,
  validateStatusInput
} from '../src/core/tools/validation';

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

describe('tool input validation', () => {
  it('requires a query for bce_find_context', () => {
    const result = validateFindContextInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"query" is required');
    }
  });

  it('reports range problems with actionable messages', () => {
    expect(validateFindContextInput({ query: 'ok', maxTokens: 5 }).ok).toBe(false);
    expect(validateFindContextInput({ query: 'ok', includeTests: 'maybe' }).ok).toBe(false);
    expect(validateFindContextInput({ query: 'x'.repeat(600) }).ok).toBe(false);
    expect(validateFileContextInput({ path: 'src/a.ts', startLine: 20, endLine: 10 }).ok).toBe(false);
    expect(validateFileContextInput({}).ok).toBe(false);
    expect(validateImpactInput({}).ok).toBe(false);
    expect(validateRelatedTestsInput({}).ok).toBe(false);
    expect(validateStatusInput({ verbose: 'yes' }).ok).toBe(false);
    expect(validateProjectOverviewInput({ maxTokens: 10 }).ok).toBe(false);
  });

  it('accepts well formed input and normalizes numbers', () => {
    const find = validateFindContextInput({ query: '  orders  ', maxTokens: '800', includeTests: false, includeSnippets: true });
    expect(find.ok).toBe(true);
    if (find.ok) {
      expect(find.value.query).toBe('orders');
      expect(find.value.maxTokens).toBe(800);
      expect(find.value.includeTests).toBe(false);
    }
    const file = validateFileContextInput({ path: 'src/index.ts', symbol: 'createServer', startLine: '5' });
    expect(file.ok).toBe(true);
    if (file.ok) {
      expect(file.value.startLine).toBe(5);
    }
    expect(validateStatusInput({}).ok).toBe(true);
    expect(validateProjectOverviewInput({ focus: 'database' }).ok).toBe(true);
  });

  it('rejects unknown types instead of coercing them silently', () => {
    const result = validateFindContextInput({ query: 42 });
    expect(result.ok).toBe(false);
    const file = validateFileContextInput({ path: { name: 'x' } });
    expect(file.ok).toBe(false);
  });
});

describe('tool handlers', () => {
  it('bce_get_project_overview renders a compact map', async () => {
    const h = await harness();
    await h.work();
    const payload = await runProjectOverview(h.intelligence, {});
    expect(payload.text).toContain('BCE project overview');
    expect(payload.text).toContain('project: fixture');
    expect(payload.text).toContain('frameworks');
    expect(payload.text).toContain('modules');
    expect(payload.estimatedTokens).toBeLessThanOrEqual(2000 + 200);
    expect(payload.text.length).toBeLessThan(9000);
  });

  it('bce_get_project_overview supports a focus and stays inside the budget', async () => {
    const h = await harness();
    await h.work();
    const payload = await runProjectOverview(h.intelligence, { focus: 'database', maxTokens: 600 });
    expect(payload.text).toContain('database objects');
    expect(payload.estimatedTokens).toBeLessThanOrEqual(600);
  });

  it('bce_find_context returns ranked hits with provenance', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFindContext(h.intelligence, { query: 'OrderService refund' });
    expect(payload.text).toContain('BCE context: "OrderService refund"');
    expect(payload.text).toContain('src/services/orderService.ts');
    expect(payload.text).toContain('provenance:');
    expect(payload.text).toContain('estimates');
    expect(payload.text).toContain('Do not attach or paste whole files');  });

  it('bce_get_file_context returns a symbol slice with dependents', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'OrderService' });
    expect(payload.text).toContain('file: src/services/orderService.ts');
    expect(payload.text).toContain('symbol: OrderService (class)');
    expect(payload.text).toContain('dependents');
    expect(payload.text).toContain('class OrderService');
  });

  it('bce_get_file_context suggests alternatives for a typo', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFileContext(h.intelligence, { path: 'src/services/orderService.ts', symbol: 'refun' });
    expect(payload.text).toContain('not found');
    expect(payload.text).toContain('refund');
  });

  it('bce_explain_impact separates verified references from heuristics', async () => {
    const h = await harness();
    await h.work();
    const payload = await runExplainImpact(h.intelligence, { symbol: 'OrderService' });
    expect(payload.text).toContain('BCE impact analysis');
    expect(payload.text).toContain('verified parser references');
    expect(payload.text).toContain('heuristic');
    expect(payload.text).toContain('src/index.ts');
  });

  it('bce_explain_impact explains an unknown symbol', async () => {
    const h = await harness();
    await h.work();
    const payload = await runExplainImpact(h.intelligence, { symbol: 'DoesNotExist' });
    expect(payload.text).toContain('not present in the index');
  });

  it('bce_explain_impact works at file level', async () => {
    const h = await harness();
    await h.work();
    const payload = await runExplainImpact(h.intelligence, { path: 'src/utils/money.ts' });
    expect(payload.text).toContain('src/services/orderService.ts');
    expect(payload.text).toContain('probable dependents');
  });

  it('bce_get_related_tests lists bound tests and runner hints', async () => {
    const h = await harness();
    await h.work();
    const payload = await runRelatedTests(h.intelligence, { path: 'src/services/orderService.ts' });
    expect(payload.text).toContain('tests/orderService.test.ts');
    expect(payload.text).toContain('runner hints');
    expect(payload.text).toContain('Vitest');
  });

  it('bce_get_related_tests finds tests by symbol', async () => {
    const h = await harness();
    await h.work();
    const payload = await runRelatedTests(h.intelligence, { symbol: 'UserController' });
    expect(payload.text).toContain('tests/UserControllerTest.php');
  });

  it('bce_get_status reports index health and cache counters', async () => {
    const h = await harness();
    await h.work();
    const payload = await runStatus(h.intelligence, { verbose: true });
    expect(payload.text).toContain('BCE status for fixture');
    expect(payload.text).toContain('complete: true');
    expect(payload.text).toContain('cache: parse entries');
    expect(payload.text).toContain('languages:');
    expect(payload.text).toContain('estimates');
  });

  it('records metric counters per tool call', async () => {
    const h = await harness();
    await h.work();
    h.metrics.recordToolCall('bce_find_context', 120, 30, 5);
    const stat = h.metrics.snapshot().tools['bce_find_context'];
    expect(stat.calls).toBe(1);
    expect(stat.estimatedTokens).toBe(30);
    expect(h.metrics.getCounter('search.lastResults')).toBeGreaterThanOrEqual(0);
  });

  it('is usable when the index is empty', async () => {
    const h = await harness();
    const payload = await runProjectOverview(h.intelligence, {});
    expect(payload.text).toContain('index v0');
    const find = await runFindContext(h.intelligence, { query: 'anything' });
    expect(find.text).toContain('No relevant files matched');
    const status = await runStatus(h.intelligence, {});
    expect(status.text).toContain('complete: false');
  });
});
