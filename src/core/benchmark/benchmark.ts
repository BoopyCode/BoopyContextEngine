import { WorkspaceIntelligence } from '../workspace';
import { defaultTokenEstimator } from '../util/tokens';
import { baseName } from '../util/paths';
import { splitIdentifier } from '../util/paths';

export interface BenchmarkTask {
  id: string;
  description: string;
  query: string;
  /** Workspace-relative paths that a correct answer should contain. */
  expectedPaths: string[];
}

export interface BenchmarkOutcome {
  taskId: string;
  query: string;
  found: boolean;
  bestRank?: number;
  returnedPaths: string[];
  bceEstimatedTokens: number;
  /** Local estimate of reading every candidate file the naive way. */
  baselineEstimatedTokens: number;
  baselineFiles: number;
  durationMs: number;
}

export interface BenchmarkReport {
  createdAt: number;
  indexVersion: number;
  tasks: BenchmarkOutcome[];
  summary: {
    taskCount: number;
    hitRate: number;
    meanRank: number;
    bceEstimatedTokens: number;
    baselineEstimatedTokens: number;
    savedPercent: number;
    notes: string[];
  };
}

/**
 * Derives reproducible benchmark tasks from the index itself: for the largest
 * modules, the task asks for the module and a correct answer is expected to
 * include its files. This makes the benchmark runnable on any project without a
 * hand written task list.
 */
export function deriveBenchmarkTasks(ws: WorkspaceIntelligence, limit = 5): BenchmarkTask[] {
  const map = ws.getMap();
  const tasks: BenchmarkTask[] = [];
  for (const module of map.overview.modules.slice(0, limit)) {
    if (module.path === '(root)') {
      continue;
    }
    const name = baseName(module.path);
    const expected = ws.index
      .filesUnder(module.path)
      .filter((file) => file.kind !== 'test')
      .slice(0, 6)
      .map((file) => file.path);
    if (expected.length === 0) {
      continue;
    }
    tasks.push({
      id: `module:${module.path}`,
      description: `Locate the implementation of the ${module.path} module`,
      query: `${module.path} ${splitIdentifier(name).join(' ')}`.trim(),
      expectedPaths: expected
    });
  }
  for (const table of map.databaseSchema.tables.slice(0, 2)) {
    tasks.push({
      id: `table:${table.name}`,
      description: `Find where the ${table.name} table is defined or migrated`,
      query: `${table.name} table migration schema`,
      expectedPaths: [table.path]
    });
  }
  for (const route of map.overview.apiRoutes.slice(0, 2)) {
    tasks.push({
      id: `route:${route.detail ?? 'GET'}:${route.name}`,
      description: `Find the handler for ${route.detail ?? 'GET'} ${route.name}`,
      query: `${route.detail ?? ''} ${route.name} route handler`.trim(),
      expectedPaths: [route.path]
    });
  }
  return tasks;
}

export function parseBenchmarkTasks(content: string): BenchmarkTask[] {
  try {
    const parsed = JSON.parse(content) as { tasks?: BenchmarkTask[] } | BenchmarkTask[];
    const raw = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
    return raw
      .filter((task) => task && typeof task.query === 'string')
      .map((task, index) => ({
        id: task.id ?? `task-${index + 1}`,
        description: task.description ?? task.query,
        query: task.query,
        expectedPaths: Array.isArray(task.expectedPaths) ? task.expectedPaths : []
      }));
  } catch {
    return [];
  }
}

/**
 * Runs the BCE tools locally and compares the context they return with a naive
 * "read every candidate file" baseline.
 *
 * What this measures: bytes/tokens the agent has to pull into the prompt to get
 * the right files. What it cannot measure: the real API bill, because BCE has no
 * access to the model provider's accounting. Agent step counts and answer quality
 * require a live agent run and are intentionally out of scope here.
 */
export async function runLocalBenchmark(
  ws: WorkspaceIntelligence,
  tasks: BenchmarkTask[],
  options: { maxTokens?: number; clock?: { now(): number } } = {}
): Promise<BenchmarkReport> {
  const estimator = defaultTokenEstimator;
  const clock = options.clock ?? { now: () => Date.now() };
  const outcomes: BenchmarkOutcome[] = [];
  const budget = options.maxTokens ?? Math.min(ws.config.tokenBudget, 2000);

  for (const task of tasks) {
    const startedAt = clock.now();
    const { bundle } = await ws.retrieveCached({
      query: task.query,
      maxTokens: budget,
      includeTests: true,
      includeSnippets: false,
      maxResults: ws.config.maxSearchResults,
      snippetLines: 0
    });
    const returnedPaths = bundle.items.map((item) => item.path);
    let bestRank: number | undefined;
    for (const expected of task.expectedPaths) {
      const rank = returnedPaths.indexOf(expected);
      if (rank >= 0 && (bestRank === undefined || rank < bestRank)) {
        bestRank = rank;
      }
    }

    const terms = splitIdentifier(task.query.toLowerCase());
    const baselineFiles = ws.index
      .allFiles()
      .filter((file) => {
        const haystack = `${file.path.toLowerCase()} ${file.symbols.map((symbol) => symbol.name.toLowerCase()).join(' ')}`;
        return terms.some((term) => term.length >= 3 && haystack.includes(term));
      })
      .filter((file) => file.kind !== 'test' || task.expectedPaths.some((path) => path.includes('test')));

    const baselineEstimatedTokens = baselineFiles.reduce((total, file) => total + Math.round(file.size / 4), 0);

    outcomes.push({
      taskId: task.id,
      query: task.query,
      found: bestRank !== undefined,
      bestRank,
      returnedPaths,
      bceEstimatedTokens: bundle.estimatedTokens,
      baselineEstimatedTokens,
      baselineFiles: baselineFiles.length,
      durationMs: clock.now() - startedAt
    });
  }

  const hits = outcomes.filter((outcome) => outcome.found);
  const ranks = hits.map((outcome) => (outcome.bestRank ?? 0) + 1);
  const bceEstimatedTokens = outcomes.reduce((total, outcome) => total + outcome.bceEstimatedTokens, 0);
  const baselineEstimatedTokens = outcomes.reduce((total, outcome) => total + outcome.baselineEstimatedTokens, 0);
  const savedPercent = baselineEstimatedTokens === 0 ? 0 : Math.max(0, Math.round(((baselineEstimatedTokens - bceEstimatedTokens) / baselineEstimatedTokens) * 1000) / 10);

  return {
    createdAt: clock.now(),
    indexVersion: ws.index.indexVersion,
    tasks: outcomes,
    summary: {
      taskCount: outcomes.length,
      hitRate: outcomes.length === 0 ? 0 : Math.round((hits.length / outcomes.length) * 100),
      meanRank: ranks.length === 0 ? 0 : Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10,
      bceEstimatedTokens,
      baselineEstimatedTokens,
      savedPercent,
      notes: [
        'Baseline = local estimate of reading every non-test file whose path or symbol names contain a query term.',
        'Token numbers come from the local estimator, not from the model provider.',
        'Answer quality, agent step count and billed API usage need a real agent session and are not measured here.',
        `Estimator: ${estimator.method}.`
      ]
    }
  };
}

export function renderBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`BCE local benchmark - ${report.tasks.length} task(s), index v${report.indexVersion}`);
  lines.push(
    `hit rate: ${report.summary.hitRate}% , mean rank of first correct hit: ${report.summary.meanRank}, estimated context: ~${report.summary.bceEstimatedTokens} tokens vs ~${report.summary.baselineEstimatedTokens} tokens for the naive baseline (${report.summary.savedPercent}% smaller)`
  );
  for (const outcome of report.tasks) {
    lines.push('');
    lines.push(`- ${outcome.taskId}: "${outcome.query}"`);
    lines.push(
      `  ${outcome.found ? `found at rank ${(outcome.bestRank ?? 0) + 1}` : 'not found'}, top hits: ${outcome.returnedPaths.slice(0, 4).join(', ') || '(none)'}`
    );
    lines.push(
      `  ~${outcome.bceEstimatedTokens} bce tokens vs ~${outcome.baselineEstimatedTokens} baseline tokens (${outcome.baselineFiles} candidate file(s)), ${outcome.durationMs} ms`
    );
  }
  lines.push('');
  for (const note of report.summary.notes) {
    lines.push(`note: ${note}`);
  }
  return lines.join('\n');
}
