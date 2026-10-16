import { WorkspaceIntelligence } from '../workspace';
import { defaultTokenEstimator, TokenBudget, TokenEstimator } from '../util/tokens';
import { clampTokenBudget } from '../config';
import { FindContextInput, FileContextInput, ImpactInput, ProjectOverviewInput, RelatedTestsInput, StatusInput } from './toolTypes';
import { renderBundle } from '../retrieve/contextRetriever';
import { describeScope } from '../retrieve/contextRetriever';

export interface ToolPayload {
  text: string;
  estimatedTokens: number;
  /**
   * Retrieval outcome, when the tool ranks hits. The usage report needs this to
   * separate "saved tokens" from "answered the question": a query that returns
   * nothing saves everything and helps nobody.
   */
  quality?: {
    hits: number;
    truncated: boolean;
    dirty: boolean;
  };
}

const DATABASE_FOCUS = new Set(['database', 'db', 'schema', 'table', 'tables', 'sql', 'migration', 'migrations', 'model', 'models']);
const API_FOCUS = new Set(['api', 'route', 'routes', 'endpoint', 'endpoints', 'controller', 'http']);
const TEST_FOCUS = new Set(['test', 'tests', 'testing', 'spec', 'specs']);
const CONFIG_FOCUS = new Set(['config', 'configuration', 'settings', 'build', 'ci']);
const FRONTEND_FOCUS = new Set(['frontend', 'ui', 'component', 'components', 'view', 'views', 'style']);

export async function runProjectOverview(ws: WorkspaceIntelligence, input: ProjectOverviewInput): Promise<ToolPayload> {
  const estimator: TokenEstimator = defaultTokenEstimator;
  const budget = new TokenBudget(clampTokenBudget(input.maxTokens, ws.config.tokenBudget), estimator);
  const map = ws.getMap();
  const overview = map.overview;
  const freshness = ws.getFreshness();
  const focus = input.focus?.trim().toLowerCase();
  const dropped: string[] = [];

  const addSection = (title: string, lines: string[]): boolean => {
    if (lines.length === 0) {
      return true;
    }
    if (!budget.tryAdd(`${title}\n${lines.join('\n')}\n`)) {
      dropped.push(title);
      return false;
    }
    return true;
  };

  const header: string[] = [];
  header.push(`project: ${overview.rootName}`);
  header.push(
    `index v${overview.indexVersion}: ${overview.fileCount} file(s) indexed, ${overview.ignoredCount} ignored, complete: ${overview.complete}${overview.partial ? ', partial (see notes)' : ''}, updated ${new Date(overview.indexedAt).toISOString()}`
  );
  const languages = Object.entries(overview.languages)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([language, count]) => `${language} ${count}`)
    .join(', ');
  header.push(`languages: ${languages || 'none detected'}`);
  budget.tryAdd(`BCE project overview\n${header.join('\n')}\n`);

  const focusSections: { title: string; lines: string[] }[] = [];

  if (!focus || DATABASE_FOCUS.has(focus) || focus.includes('database') || focus.includes('schema')) {
    const tables = map.databaseSchema.tables.filter((entry) => entry.kind === 'table');
    focusSections.push({
      title: `database objects (${tables.length} table(s), ${map.databaseSchema.migrations.length} migration file(s))`,
      lines: tables.slice(0, 20).map((table) => `  - ${table.name} (${table.columns.length} column(s)) ${table.path}:${table.line}${table.references.length > 0 ? ` -> ${table.references.join(',')}` : ''}`)
    });
  }

  if (!focus || API_FOCUS.has(focus)) {
    focusSections.push({
      title: `api routes (${overview.apiRoutes.length})`,
      lines: overview.apiRoutes
        .slice(0, 20)
        .map((route) => `  - ${route.detail ? `${route.detail} ` : ''}${route.name} ${route.path}:${route.line}${route.confidence === 'heuristic' ? ' (heuristic)' : ''}`)
    });
  }

  if (!focus || TEST_FOCUS.has(focus)) {
    focusSections.push({
      title: `tests (${overview.tests.length} test file(s))`,
      lines: [
        ...overview.testConfigFiles.map((config) => `  config: ${config}`),
        ...overview.tests.slice(0, 15).map((test) => `  - ${test.path}${test.testedPath ? ` -> ${test.testedPath}` : ''}`)
      ]
    });
  }

  if (focus && !DATABASE_FOCUS.has(focus) && !API_FOCUS.has(focus) && !TEST_FOCUS.has(focus) && !CONFIG_FOCUS.has(focus) && !FRONTEND_FOCUS.has(focus)) {
    const matchingSymbols = ws.index
      .allFiles()
      .flatMap((file) => file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(focus)).map((symbol) => ({ file, symbol })))
      .slice(0, 20);
    focusSections.push({
      title: `symbols matching "${input.focus}" (${matchingSymbols.length})`,
      lines: matchingSymbols.map((match) => `  - ${match.symbol.name} (${match.symbol.kind}) ${match.file.path}:${match.symbol.line}`)
    });
    const matchingModules = overview.modules.filter((module) => module.path.toLowerCase().includes(focus));
    focusSections.push({
      title: `modules matching "${input.focus}" (${matchingModules.length})`,
      lines: matchingModules.slice(0, 12).map((module) => `  - ${module.path}: ${module.fileCount} file(s), symbols: ${module.topSymbols.slice(0, 5).join(', ')}`)
    });
  }

  if (focus && CONFIG_FOCUS.has(focus)) {
    focusSections.push({
      title: `configuration files (${overview.configFiles.length})`,
      lines: overview.configFiles.slice(0, 25).map((file) => `  - ${file}`)
    });
  }

  if (focus && FRONTEND_FOCUS.has(focus)) {
    const components = ws.index
      .allFiles()
      .flatMap((file) => file.symbols.filter((symbol) => symbol.kind === 'component').map((symbol) => ({ file, symbol })))
      .slice(0, 25);
    focusSections.push({
      title: `UI components (${components.length})`,
      lines: components.map((match) => `  - ${match.symbol.name} ${match.file.path}:${match.symbol.line}`)
    });
  }

  for (const section of focusSections) {
    addSection(section.title, section.lines);
  }

  addSection(
    `frameworks (${overview.frameworks.length})`,
    overview.frameworks.map((framework) => `  - ${framework.name} (${framework.confidence}): ${framework.evidence}`)
  );

  addSection(
    `entry points (${overview.entryPoints.length})`,
    overview.entryPoints.map((entry) => `  - ${entry}`)
  );

  addSection(
    `modules (${overview.modules.length}, largest first)`,
    overview.modules.slice(0, 15).map((module) => {
      const dependents = module.dependents > 0 ? `, used by ${module.dependents} other module(s)` : '';
      return `  - ${module.path}: ${module.fileCount} file(s)${dependents} [${module.languages.join(', ')}]${module.topSymbols.length > 0 ? ` symbols: ${module.topSymbols.slice(0, 6).join(', ')}` : ''}`;
    })
  );

  addSection(
    `project instructions (${overview.projectInstructions.length})`,
    overview.projectInstructions.map((file) => `  - ${file}`)
  );

  const notes: string[] = [];
  if (!overview.complete) {
    notes.push('the index is still being built, so parts of the project are missing');
  }
  if (freshness.stale) {
    notes.push('files changed since the last index update');
  }
  if (overview.partial) {
    notes.push('some files could not be parsed or were skipped because of limits (see bce_get_status)');
  }
  if (overview.errors.length > 0) {
    notes.push(`${overview.errors.length} indexing error(s), first: ${overview.errors[0].path} - ${overview.errors[0].message}`);
  }
  addSection('notes', notes.map((note) => `  - ${note}`));
  if (dropped.length > 0) {
    budget.tryAdd(`note: sections omitted because of the token budget: ${dropped.join(', ')}. Increase maxTokens or use a focus.\n`);
  }
  budget.tryAdd('next: use bce_find_context for a specific task, or bce_get_file_context for exact symbols.\n');

  const text = budget.toString().trimEnd();
  return { text, estimatedTokens: estimator.estimate(text) };
}

export async function runFindContext(ws: WorkspaceIntelligence, input: FindContextInput): Promise<ToolPayload> {
  const estimator = defaultTokenEstimator;
  const maxTokens = clampTokenBudget(input.maxTokens, ws.config.tokenBudget);
  const symbolsOnly = input.symbolsOnly === true;
  const recent = await ws.recentChanges();
  const { bundle, fromCache } = await ws.retrieveCached({
    query: input.query,
    scope: input.scope,
    maxTokens,
    includeTests: input.includeTests ?? true,
    includeSnippets: symbolsOnly ? false : input.includeSnippets ?? true,
    symbolsOnly,
    maxResults: ws.config.maxSearchResults,
    snippetLines: ws.config.snippetLines,
    recentPaths: recent.available ? recent.changedPaths : [],
    entryPoints: ws.getMap().entryPoints
  });
  const freshness = ws.getFreshness();
  const coverage = ws.impactCoverage();
  const lines: string[] = [renderBundle(bundle, freshness)];
  lines.push('');
  lines.push(
    `index scope: ${ws.index.size} file(s) indexed, ${ws.index.getIgnored().length} ignored (see bce_get_project_overview for the ignored reasons)`
  );
  lines.push(
    `coverage: ${coverage.linkedPercent}% of internal imports linked ` +
      `(${coverage.unresolvedInternalImports}/${coverage.internalImports} unresolved in ${coverage.filesWithUnresolvedImports} file(s))` +
      (bundle.items.length === 0 && coverage.unresolvedInternalImports > 0
        ? ' - an empty result here is NOT proof of absence: a file the parser could not link is invisible to this search.'
        : '')
  );
  lines.push('');
  lines.push(
    `provenance: ${fromCache ? 'served from the local context cache' : 'computed now'}; recent-change signal: ${
      recent.available ? `git (${recent.branch ?? 'detached'}, last ${ws.config.recencyDays} days)` : `unavailable (${recent.reason ?? 'no git'})`
    }; scope: ${input.scope ? describeScope(input.scope) : 'whole workspace'}; tests included: ${input.includeTests ?? true}`
  );
  lines.push(
    'next: open only the listed ranges. Do not attach or paste whole files - that duplicates this context and costs extra tokens. Use bce_get_file_context for an exact symbol body.'
  );
  if (symbolsOnly) {
    lines.push(
      'mode: symbolsOnly (phase one). No code bodies were read. Pick a target above and request it with bce_get_file_context - do not read whole files to compensate.'
    );
  }
  lines.push(
    `token numbers are BCE estimates (${bundle.estimatorMethod}), not the model provider's billed counts.`
  );
  const text = lines.join('\n');
  return {
    text,
    estimatedTokens: estimator.estimate(text),
    quality: { hits: bundle.items.length, truncated: bundle.truncated, dirty: bundle.dirtyCount > 0 }
  };
}

export async function runFileContext(ws: WorkspaceIntelligence, input: FileContextInput): Promise<ToolPayload> {
  const estimator = defaultTokenEstimator;
  const resolution = ws.resolvePath(input.path);
  if (!resolution.ok || !resolution.relPath) {
    return { text: `BCE refused the path.\n${resolution.error}`, estimatedTokens: 0 };
  }
  const relPath = resolution.relPath;
  const result = await ws.renderFileContext(relPath, { symbol: input.symbol, startLine: input.startLine, endLine: input.endLine }, clampTokenBudget(input.maxTokens, ws.config.tokenBudget));
  if (result.error && result.text.length === 0) {
    return { text: `BCE could not return the requested slice.\n${result.error}`, estimatedTokens: 0 };
  }
  const extras: string[] = [result.text];
  const record = ws.index.get(relPath);
  if (record) {
    const dependents = ws.index.reverseDependencies(relPath).slice(0, 10);
    if (dependents.length > 0) {
      extras.push('');
      extras.push(`dependents (${dependents.length}): ${dependents.map((file) => file.path).join(', ')}`);
    }
    const exports = record.symbols.filter((symbol) => symbol.exported).slice(0, 12);
    if (exports.length > 0) {
      extras.push(`exported symbols: ${exports.map((symbol) => `${symbol.name} (${symbol.kind}, L${symbol.line})`).join(', ')}`);
    }
  }
  if (result.error) {
    extras.push(`note: ${result.error}`);
  }
  const text = extras.join('\n');
  return { text, estimatedTokens: estimator.estimate(text) };
}

export async function runExplainImpact(ws: WorkspaceIntelligence, input: ImpactInput): Promise<ToolPayload> {
  const estimator = defaultTokenEstimator;
  const budget = new TokenBudget(clampTokenBudget(input.maxTokens, ws.config.tokenBudget), estimator);
  const report = await ws.buildImpactReport({ path: input.path, symbol: input.symbol });
  const lines: string[] = [];
  lines.push(
    `BCE impact analysis for ${report.target.kind === 'symbol' ? `symbol ${report.target.symbol}` : `file ${report.target.path}`}${
      report.target.kind === 'symbol' && report.target.path ? ` (defined in ${report.target.path})` : ''
    }`
  );
  lines.push(`index v${report.indexVersion}, freshness: ${report.freshness.complete ? (report.freshness.stale ? 'stale (pending updates)' : 'fresh') : 'incomplete'}`);
  lines.push(
    `coverage: ${report.coverage.linkedPercent}% of internal imports linked ` +
      `(${report.coverage.unresolvedInternalImports}/${report.coverage.internalImports} unresolved, ` +
      `${report.coverage.filesWithUnresolvedImports} file(s) affected)`
  );

  // A report about a target that could not be located must not print three empty
  // sections. "verified parser references (0) - safe to trust" reads as a finding,
  // and an empty list is far more often a hole in the index than an answer.
  if (!report.resolved) {
    lines.push('');
    lines.push('NOT ANALYSED - the requested target could not be resolved:');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
    lines.push('');
    lines.push('No reference, dependent or heuristic list is shown on purpose: an empty list here would be indistinguishable from "nothing depends on this".');
    return finishImpact(lines, budget, estimator);
  }

  const graphIncomplete = report.coverage.unresolvedInternalImports > 0;
  lines.push('');
  lines.push(
    `verified parser references (${report.verified.length})${
      graphIncomplete ? ' - parser-confirmed, but the import graph is incomplete, see coverage' : ' - these are safe to trust'
    }:`
  );
  lines.push(
    report.verified.length === 0
      ? graphIncomplete
        ? '  (none found) - NOT proof of absence: the parser cannot link every import in this workspace yet.'
        : '  (none found)'
      : report.verified
          .slice(0, 25)
          .map((reference) => `  - ${reference.path}:${reference.line} (${reference.kind})`)
          .join('\n')
  );
  lines.push('');
  lines.push(`probable dependents from the import graph (${report.dependents.length}) - check before refactoring:`);
  lines.push(report.dependents.length === 0 ? '  (none found)' : report.dependents.slice(0, 20).map((entry) => `  - ${entry.path} (${entry.reason})`).join('\n'));
  lines.push('');
  lines.push(`heuristic text matches (${report.heuristics.length}) - verify these in the files:`);
  lines.push(report.heuristics.length === 0 ? '  (none found)' : report.heuristics.slice(0, 20).map((entry) => `  - ${entry.path} (${entry.reason})`).join('\n'));
  if (report.tests.length > 0) {
    lines.push('');
    lines.push(`related tests (${report.tests.length}): ${report.tests.slice(0, 12).join(', ')}`);
  }
  if (report.relatedDatabase.length > 0) {
    lines.push('');
    lines.push('database objects involved:');
    for (const table of report.relatedDatabase.slice(0, 10)) {
      lines.push(`  - ${table.name} (${table.kind}) ${table.path}:${table.line}${table.references.length > 0 ? ` -> ${table.references.join(',')}` : ''}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('caveats:');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return finishImpact(lines, budget, estimator);
}

function finishImpact(lines: string[], budget: TokenBudget, estimator: TokenEstimator): ToolPayload {
  const text = lines.join('\n');
  const accepted = budget.tryAdd(text);
  const finalText = accepted
    ? text
    : `${budget.toString()}\n... (impact report truncated by the token budget; narrow it with "symbol" or raise maxTokens)`;
  return { text: finalText, estimatedTokens: estimator.estimate(finalText) };
}

export async function runRelatedTests(ws: WorkspaceIntelligence, input: RelatedTestsInput): Promise<ToolPayload> {
  const estimator = defaultTokenEstimator;
  const report = await ws.buildRelatedTestsReport({ path: input.path, symbol: input.symbol });
  const lines: string[] = [];
  lines.push(`BCE related tests for ${input.symbol ? `symbol ${input.symbol}` : `file ${input.path}`}${report.target.path && input.symbol ? ` (in ${report.target.path})` : ''}`);
  lines.push(`index v${report.indexVersion}`);
  if (report.tests.length === 0) {
    lines.push('no existing test file was matched.');
  } else {
    lines.push(`matching test file(s) (${report.tests.length}):`);
    for (const test of report.tests.slice(0, 20)) {
      lines.push(`  - ${test.path} (${test.confidence})${test.testedPath ? ` -> ${test.testedPath}` : ''}: ${test.reason}`);
    }
  }
  if (report.testConfigFiles.length > 0) {
    lines.push(`test configuration: ${report.testConfigFiles.join(', ')}`);
  }
  if (report.runnerHints.length > 0) {
    lines.push('runner hints:');
    for (const hint of report.runnerHints) {
      lines.push(`  - ${hint}`);
    }
  }
  for (const warning of report.warnings) {
    lines.push(`note: ${warning}`);
  }
  lines.push('when adding a test, follow the structure of the nearest listed test file and place the new file next to it.');
  const text = lines.join('\n');
  return { text, estimatedTokens: estimator.estimate(text) };
}

export async function runStatus(ws: WorkspaceIntelligence, input: StatusInput): Promise<ToolPayload> {
  const estimator = defaultTokenEstimator;
  const text = ws.status(input.verbose ?? false);
  return { text, estimatedTokens: estimator.estimate(text) };
}
