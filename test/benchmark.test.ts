import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { deriveBenchmarkTasks, parseBenchmarkTasks, renderBenchmarkReport, runLocalBenchmark } from '../src/core/benchmark/benchmark';

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

describe('local benchmark', () => {
  it('derives reproducible tasks from the project structure', async () => {
    const h = await harness();
    await h.work();
    const tasks = deriveBenchmarkTasks(h.intelligence);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => task.query.length > 0 && task.expectedPaths.length > 0)).toBe(true);
    expect(tasks.some((task) => task.id.startsWith('module:'))).toBe(true);
  });

  it('parses task files and tolerates broken json', () => {
    const tasks = parseBenchmarkTasks(JSON.stringify({ tasks: [{ id: 'x', query: 'orders', expectedPaths: ['a.ts'] }] }));
    expect(tasks).toEqual([{ id: 'x', description: 'orders', query: 'orders', expectedPaths: ['a.ts'] }]);
    expect(parseBenchmarkTasks('{ not json')).toEqual([]);
  });

  it('finds the right modules and reports smaller context than the naive baseline', async () => {
    const h = await harness();
    await h.work();
    const report = await runLocalBenchmark(h.intelligence, deriveBenchmarkTasks(h.intelligence), { maxTokens: 900 });
    expect(report.tasks.length).toBeGreaterThan(0);
    expect(report.summary.hitRate).toBeGreaterThan(0);
    expect(report.summary.baselineEstimatedTokens).toBeGreaterThan(0);
    expect(report.summary.bceEstimatedTokens).toBeGreaterThan(0);
    expect(report.summary.savedPercent).toBeGreaterThan(0);
    expect(report.summary.notes.join(' ')).toContain('estimator');
    const text = renderBenchmarkReport(report);
    expect(text).toContain('hit rate');
    expect(text).toContain('note:');
  });

  it('stays honest about what it cannot measure', async () => {
    const h = await harness();
    await h.work();
    const report = await runLocalBenchmark(h.intelligence, [{ id: 'one', description: 'd', query: 'OrderService', expectedPaths: ['src/services/orderService.ts'] }]);
    expect(report.summary.notes.join(' ')).toContain('not from the model provider');
    expect(report.summary.notes.join(' ')).toContain('agent session');
  });
});
