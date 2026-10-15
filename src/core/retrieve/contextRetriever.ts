import {
  Confidence,
  FileKind,
  FileRecord,
  IndexFreshness,
  LanguageId,
  SymbolRecord
} from '../types';
import { baseName, dirOf, isInside, splitIdentifier } from '../util/paths';
import { defaultTokenEstimator, TokenBudget, TokenEstimator } from '../util/tokens';
import { ProjectIndex } from '../index/indexModel';
import { LineRange, renderSnippet } from './snippets';

export interface RetrieveOptions {
  query: string;
  scope?: string;
  maxTokens: number;
  includeTests: boolean;
  includeSnippets: boolean;
  maxResults: number;
  snippetLines: number;
  /** Paths changed recently (for example from git), used as a relevance signal. */
  recentPaths?: readonly string[];
  entryPoints?: readonly string[];
}

export interface ContextItemSymbol {
  name: string;
  kind: SymbolRecord['kind'];
  line: number;
  endLine?: number;
  signature?: string;
  confidence: Confidence;
}

export interface ContextItem {
  path: string;
  language: LanguageId;
  kind: FileKind;
  score: number;
  reasons: string[];
  symbols: ContextItemSymbol[];
  ranges: LineRange[];
  snippet?: string;
  snippetTruncated?: boolean;
  /** True when the snippet comes from an open editor buffer with unsaved changes. */
  dirty?: boolean;
  tests?: string[];
  confidence: Confidence;
}

export interface ContextBundle {
  query: string;
  scope?: string;
  indexVersion: number;
  items: ContextItem[];
  candidates: number;
  estimatedTokens: number;
  budget: number;
  truncated: boolean;
  /** Number of returned items whose snippet came from an unsaved editor buffer. */
  dirtyCount: number;
  warnings: string[];
  estimatorMethod: string;
  durationMs: number;
}

export interface RetrieverDeps {
  /** Reads file content for snippets; returns `dirty` for unsaved editor buffers. */
  readFile(path: string): Promise<{ text: string; dirty: boolean } | undefined>;
  estimator?: TokenEstimator;
  clock?: { now(): number };
}

interface ScoredFile {
  file: FileRecord;
  score: number;
  reasons: string[];
  matchedSymbols: SymbolRecord[];
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'in',
  'on',
  'of',
  'for',
  'and',
  'or',
  'to',
  'with',
  'how',
  'what',
  'where',
  'which',
  'does',
  'do',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'its',
  'by',
  'from',
  'at',
  'as',
  'all',
  'need',
  'want',
  'please',
  'problem',
  'issue'
]);

const KIND_HINTS: { terms: string[]; kinds: FileKind[]; symbolKinds: SymbolRecord['kind'][]; reason: string }[] = [
  { terms: ['test', 'tests', 'spec', 'specs', 'unit', 'coverage'], kinds: ['test'], symbolKinds: [], reason: 'query asks about tests' },
  { terms: ['route', 'routes', 'endpoint', 'endpoints', 'api', 'controller'], kinds: [], symbolKinds: ['route'], reason: 'query asks about API routes' },
  {
    terms: ['migration', 'migrations', 'schema', 'table', 'tables', 'database', 'db', 'sql'],
    kinds: ['migration', 'schema'],
    symbolKinds: ['table', 'column', 'view'],
    reason: 'query asks about database objects'
  },
  { terms: ['config', 'configuration', 'settings', 'env'], kinds: ['config'], symbolKinds: [], reason: 'query asks about configuration' },
  { terms: ['component', 'components', 'view', 'ui'], kinds: [], symbolKinds: ['component'], reason: 'query asks about UI components' },
  { terms: ['class', 'interface', 'type', 'model'], kinds: [], symbolKinds: ['class', 'interface', 'type'], reason: 'query asks about types' }
];

const RECENCY_TERMS = new Set(['recent', 'recently', 'changed', 'change', 'latest', 'new', 'newest', 'modified']);
const ENTRY_TERMS = new Set(['entry', 'main', 'start', 'bootstrap', 'boot', 'cli', 'server']);
const TEST_TERMS = new Set(['test', 'tests', 'spec', 'specs', 'unit', 'coverage']);

/**
 * Ranks indexed files and symbols for a query, then assembles a token bounded
 * context bundle. Everything is local; no network calls are involved.
 */
export class ContextRetriever {
  private readonly estimator: TokenEstimator;
  private readonly clock: { now(): number };

  constructor(
    private readonly index: ProjectIndex,
    private readonly deps: RetrieverDeps
  ) {
    this.estimator = deps.estimator ?? defaultTokenEstimator;
    this.clock = deps.clock ?? { now: () => Date.now() };
  }

  async retrieve(options: RetrieveOptions, freshness: IndexFreshness): Promise<ContextBundle> {
    const startedAt = this.clock.now();
    const warnings: string[] = [];
    const terms = tokenize(options.query);
    if (terms.length === 0) {
      return {
        query: options.query,
        scope: options.scope,
        indexVersion: this.index.indexVersion,
        items: [],
        candidates: 0,
        estimatedTokens: 0,
        budget: options.maxTokens,
        truncated: false,
        dirtyCount: 0,
        warnings: ['The query contained no usable search terms.'],
        estimatorMethod: this.estimator.method,
        durationMs: this.clock.now() - startedAt
      };
    }

    const scope = options.scope?.trim();
    const scopePrefix = scope && scope.length > 0 ? scope.replace(/^\.?\//, '').replace(/\/+$/, '') : undefined;
    const recent = new Set(options.recentPaths ?? []);
    const entries = new Set(options.entryPoints ?? []);
    const wantsRecent = terms.some((term) => RECENCY_TERMS.has(term));
    const wantsEntry = terms.some((term) => ENTRY_TERMS.has(term));
    const wantsTests = terms.some((term) => TEST_TERMS.has(term));

    const scored: ScoredFile[] = [];
    let candidates = 0;
    for (const file of this.index.allFiles()) {
      if (scopePrefix && !isInside(scopePrefix, file.path)) {
        continue;
      }
      if (!options.includeTests && file.kind === 'test') {
        continue;
      }
      candidates += 1;
      const result = this.scoreFile(file, terms, { recent, wantsRecent, entries, wantsEntry, wantsTests });
      if (result && result.score > 0) {
        scored.push(result);
      }
    }

    this.applyGraphProximity(scored);
    scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const shortlisted = scored.slice(0, Math.max(options.maxResults, 1));
    const items: ContextItem[] = [];
    for (const candidate of shortlisted) {
      items.push(await this.toContextItem(candidate, options));
    }

    const budget = new TokenBudget(options.maxTokens, this.estimator);
    const kept: ContextItem[] = [];
    for (const item of items) {
      const rendered = renderItem(item, kept.length + 1);
      if (!budget.tryAdd(`${rendered}\n`)) {
        item.snippet = undefined;
        const withoutSnippet = renderItem(item, kept.length + 1);
        if (!budget.tryAdd(`${withoutSnippet}\n`)) {
          break;
        }
        kept.push(item);
        continue;
      }
      kept.push(item);
    }

    const truncated = kept.length < items.length;
    if (truncated) {
      warnings.push(
        `The token budget (${options.maxTokens}) was reached after ${kept.length} of ${items.length} ranked hits. Narrow the query or the scope to see the rest.`
      );
    }
    if (kept.length === 0 && items.length === 0) {
      warnings.push('No indexed file matched the query terms. Try different terms, name a symbol or file directly, or drop the scope filter.');
    }
    const dirtyCount = kept.filter((item) => item.dirty).length;
    if (dirtyCount > 0) {
      warnings.push(
        `${dirtyCount} snippet(s) come from open editor buffers with unsaved changes: their line numbers can differ from the file on disk. Save the file or re-read it with bce_get_file_context after saving.`
      );
    }
    if (!this.index.complete) {
      warnings.push('The index is not complete yet; results may be missing files that are still being indexed.');
    }
    if (freshness.stale) {
      warnings.push('The index has pending updates, so very recent edits may not be reflected.');
    }

    return {
      query: options.query,
      scope: options.scope,
      indexVersion: this.index.indexVersion,
      items: kept,
      candidates,
      estimatedTokens: budget.used,
      budget: options.maxTokens,
      truncated,
      dirtyCount,
      warnings,
      estimatorMethod: this.estimator.method,
      durationMs: this.clock.now() - startedAt
    };
  }

  private scoreFile(
    file: FileRecord,
    terms: string[],
    context: { recent: Set<string>; wantsRecent: boolean; entries: Set<string>; wantsEntry: boolean; wantsTests: boolean }
  ): ScoredFile | undefined {
    const reasons: string[] = [];
    const matchedSymbols: SymbolRecord[] = [];
    let score = 0;
    const lowerPath = file.path.toLowerCase();
    const fileName = baseName(file.path).toLowerCase();
    const pathTerms = new Set(splitIdentifier(file.path));

    for (const term of terms) {
      if (fileName === term) {
        score += 14;
        reasons.push(`file name is exactly "${term}"`);
        continue;
      }
      if (pathTerms.has(term)) {
        score += 6;
        reasons.push(`path contains "${term}"`);
        continue;
      }
      if (lowerPath.includes(term) && term.length >= 3) {
        score += 3;
        reasons.push(`path matches "${term}"`);
      }
    }

    for (const symbol of file.symbols) {
      const symbolName = symbol.name.toLowerCase();
      for (const term of terms) {
        if (symbolName === term) {
          score += 16;
          matchedSymbols.push(symbol);
          reasons.push(`symbol ${symbol.name} (${symbol.kind}) matches "${term}"`);
          break;
        }
        if (symbolName.startsWith(term) && term.length >= 3) {
          score += 7;
          matchedSymbols.push(symbol);
          reasons.push(`symbol ${symbol.name} (${symbol.kind}) starts with "${term}"`);
          break;
        }
        if (term.length >= 4 && symbolName.includes(term)) {
          score += 4;
          matchedSymbols.push(symbol);
          reasons.push(`symbol ${symbol.name} (${symbol.kind}) contains "${term}"`);
          break;
        }
      }
      const haystack = `${symbol.doc ?? ''} ${symbol.signature ?? ''}`.toLowerCase();
      for (const term of terms) {
        if (term.length >= 4 && haystack.includes(term)) {
          score += 1.5;
          break;
        }
      }
    }

    for (const importRecord of file.imports) {
      const specifier = importRecord.specifier.toLowerCase();
      for (const term of terms) {
        if (term.length >= 4 && specifier.includes(term)) {
          score += 2.5;
          reasons.push(`imports "${importRecord.specifier}"`);
          break;
        }
      }
    }

    for (const hint of KIND_HINTS) {
      if (!terms.some((term) => hint.terms.includes(term))) {
        continue;
      }
      if (hint.kinds.includes(file.kind)) {
        score += 3;
        reasons.push(hint.reason);
      }
      const symbolKindMatch = file.symbols.find((symbol) => hint.symbolKinds.includes(symbol.kind));
      if (symbolKindMatch) {
        score += 3;
        if (!matchedSymbols.includes(symbolKindMatch)) {
          matchedSymbols.push(symbolKindMatch);
        }
        reasons.push(hint.reason);
      }
    }

    if (file.kind === 'test') {
      // Tests are useful evidence, but only a weak signal on their own.
      score += context.wantsTests ? 4 : 0;
    }
    if (context.recent.has(file.path)) {
      score += context.wantsRecent ? 6 : 1.5;
      if (context.wantsRecent) {
        reasons.push('changed recently (git)');
      }
    }
    if (context.wantsEntry && context.entries.has(file.path)) {
      score += 5;
      reasons.push('project entry point');
    }
    if (file.parseError) {
      score -= 2;
      reasons.push('last parse attempt failed for this file');
    }

    if (score <= 0) {
      return undefined;
    }
    return { file, score, reasons: dedupe(reasons).slice(0, 4), matchedSymbols };
  }

  /** Files close to the best hits are boosted: importers and imported modules. */
  private applyGraphProximity(scored: ScoredFile[]): void {
    const seeds = [...scored].sort((a, b) => b.score - a.score).slice(0, 4);
    if (seeds.length === 0) {
      return;
    }
    const seedPaths = new Map(seeds.map((seed) => [seed.file.path, seed] as const));
    const byPath = new Map(scored.map((entry) => [entry.file.path, entry] as const));
    for (const entry of scored) {
      for (const dependency of entry.file.dependencies) {
        const seed = seedPaths.get(dependency);
        if (seed && seed !== entry) {
          entry.score += 1.5;
          entry.reasons.push(`imports ${dependency}`);
          break;
        }
      }
      if (entry.reasons.length >= 4) {
        continue;
      }
      for (const seed of seeds) {
        if (seed.file.dependencies.includes(entry.file.path)) {
          entry.score += 1;
          entry.reasons.push(`used by ${seed.file.path}`);
          break;
        }
      }
    }
    for (const seed of seeds) {
      byPath.set(seed.file.path, seed);
    }
  }

  private async toContextItem(candidate: ScoredFile, options: RetrieveOptions): Promise<ContextItem> {
    const file = candidate.file;
    const ranges: LineRange[] = [];
    for (const symbol of candidate.matchedSymbols.slice(0, 6)) {
      const end = symbol.endLine ? Math.min(symbol.endLine, symbol.line + options.snippetLines - 1) : symbol.line + Math.min(options.snippetLines, 6) - 1;
      ranges.push({ start: symbol.line, end: Math.max(symbol.line, end) });
    }
    if (ranges.length === 0 && options.includeSnippets) {
      const head = file.symbols.filter((symbol) => symbol.kind !== 'column').slice(0, 3);
      for (const symbol of head) {
        ranges.push({ start: symbol.line, end: symbol.line + Math.min(options.snippetLines, 6) - 1 });
      }
      if (ranges.length === 0) {
        ranges.push({ start: 1, end: Math.min(options.snippetLines, 10) });
      }
    }

    const item: ContextItem = {
      path: file.path,
      language: file.language,
      kind: file.kind,
      score: Math.round(candidate.score * 10) / 10,
      reasons: candidate.reasons,
      symbols: candidate.matchedSymbols.slice(0, 6).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        signature: symbol.signature,
        confidence: symbol.confidence
      })),
      ranges,
      tests: file.tests,
      confidence: file.confidence
    };

    if (options.includeSnippets && ranges.length > 0) {
      const content = await this.deps.readFile(file.path);
      if (content === undefined) {
        return item;
      }
      const snippet = renderSnippet(content.text, ranges, options.snippetLines);
      item.snippet = snippet.text;
      item.snippetTruncated = snippet.truncated;
      item.dirty = content.dirty;
      item.ranges = snippet.ranges;
    }
    return item;
  }
}

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/[\s,;:()"'`]+/)) {
    const cleaned = raw.trim();
    if (cleaned.length === 0) {
      continue;
    }
    const parts = splitIdentifier(cleaned);
    if (parts.length === 0) {
      continue;
    }
    const whole = cleaned.toLowerCase().replace(/[^\w$#-]/g, '');
    const additions = [whole, ...parts].filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
    for (const term of additions) {
      if (seen.has(term)) {
        continue;
      }
      seen.add(term);
      terms.push(term);
    }
  }
  return terms.slice(0, 24);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Compact rendering used as the tool payload and for token accounting. */
export function renderItem(item: ContextItem, index: number): string {
  const dirtyMarker = item.dirty ? ' (UNSAVED editor content)' : '';
  const header = `${index}. ${item.path} [${item.language}${item.kind === 'source' ? '' : `, ${item.kind}`}] score ${item.score}${dirtyMarker}`;
  const lines: string[] = [header];
  if (item.reasons.length > 0) {
    lines.push(`   why: ${item.reasons.join('; ')}`);
  }
  if (item.symbols.length > 0) {
    const symbols = item.symbols
      .map((symbol) => `${symbol.name}(${symbol.kind})${symbol.line ? ` L${symbol.line}${symbol.endLine ? `-${symbol.endLine}` : ''}` : ''}`)
      .join(', ');
    lines.push(`   symbols: ${symbols}`);
  }
  if (item.tests && item.tests.length > 0) {
    lines.push(`   tests: ${item.tests.slice(0, 4).join(', ')}`);
  }
  if (item.snippet) {
    lines.push('   code:');
    lines.push(
      item.snippet
        .split('\n')
        .map((line) => `     ${line}`)
        .join('\n')
    );
    if (item.snippetTruncated) {
      lines.push('     ... (snippet shortened, use bce_get_file_context for more)');
    }
  }
  return lines.join('\n');
}

export function renderBundle(bundle: ContextBundle, freshness: IndexFreshness): string {
  const status = freshness.complete ? (freshness.stale ? 'updated, pending changes' : 'fresh') : 'indexing / partial';
  const lines: string[] = [];
  lines.push(`BCE context: "${bundle.query}"${bundle.scope ? ` in ${bundle.scope}` : ''}`);
  lines.push(
    `index v${bundle.indexVersion} (${status}), scanned ${bundle.candidates} file(s), returning ${bundle.items.length} ranked hit(s), ~${bundle.estimatedTokens}/${bundle.budget} ${bundle.estimatorMethod}, ${bundle.durationMs} ms`
  );
  if (bundle.items.length === 0) {
    lines.push('No relevant files matched. Try different terms, or drop the scope filter.');
  }
  for (const [index, item] of bundle.items.entries()) {
    lines.push('');
    lines.push(renderItem(item, index + 1));
  }
  if (bundle.truncated) {
    lines.push('');
    lines.push('... (more hits were cut off by the token budget)');
  }
  for (const warning of bundle.warnings) {
    lines.push(`note: ${warning}`);
  }
  return lines.join('\n');
}

export function describeScope(path: string): string {
  const dir = dirOf(path);
  return dir === '' ? '(root)' : dir;
}
