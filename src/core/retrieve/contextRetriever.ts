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
import { fileTermsOf, matchSymbolTerm, nameTerms, SYMBOL_KIND_BONUS, SymbolMatchKind, TERM_FILE_AFFINITY, symbolMatchDecay } from './symbolRanking';

export interface RetrieveOptions {
  query: string;
  scope?: string;
  maxTokens: number;
  includeTests: boolean;
  includeSnippets: boolean;
  maxResults: number;
  snippetLines: number;
  /**
   * Index-only mode: return ranked `path:line` hits without reading any file body.
   * This is phase one of a two-phase lookup - the agent picks a target from the
   * cheap list and asks for the body with `bce_get_file_context` afterwards, which
   * avoids paying for snippets of nine files to use the tenth.
   */
  symbolsOnly?: boolean;
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
  /**
   * Rendering mode the bundle was assembled in. `renderBundle` must use the same
   * one, otherwise the token estimate (computed with the compact renderer) and
   * the printed text (verbose) disagree, and a phase-one list comes out as a
   * full context bundle.
   */
  mode: 'snippets' | 'index';
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

/** A query term together with how much a match on it is worth (rarer = more). */
interface WeightedTerm {
  term: string;
  weight: number;
}

/** Points added per distinct query term a file matches, beyond the first. */
const COVERAGE_BONUS = 4;

/**
 * Rarity weight for a term that appears in `frequency` of `total` files.
 *
 * A term in every file says nothing; a term in a few files says a lot. The
 * curve is deliberately gentle (a 1..4 range) because the per-term weights
 * multiply the existing scoring constants, and a violent weight would let one
 * rare word override every other signal.
 */
function idfWeight(frequency: number, total: number): number {
  if (total <= 0 || frequency <= 0) {
    return 1;
  }
  const ratio = frequency / total;
  if (ratio >= 0.5) {
    return 1;
  }
  if (ratio >= 0.2) {
    return 1.6;
  }
  if (ratio >= 0.05) {
    return 2.4;
  }
  return 3.4;
}

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
        durationMs: this.clock.now() - startedAt,
        mode: options.symbolsOnly ? 'index' : 'snippets'
      };
    }

    const scope = options.scope?.trim();
    const scopePrefix = scope && scope.length > 0 ? scope.replace(/^\.?\//, '').replace(/\/+$/, '') : undefined;
    const recent = new Set(options.recentPaths ?? []);
    const entries = new Set(options.entryPoints ?? []);
    const wantsRecent = terms.some((term) => RECENCY_TERMS.has(term));
    const wantsEntry = terms.some((term) => ENTRY_TERMS.has(term));
    const wantsTests = terms.some((term) => TEST_TERMS.has(term));

    // How many files each term appears in. A term in two files is evidence; the
    // same term in fifty is background noise. Without this, "service" and
    // "user" drown out "audit" and "refund" in a long natural-language query.
    const termWeights = this.termWeights(terms, scopePrefix, options.includeTests);
    const weightedTerms = terms.map((term) => ({ term, weight: termWeights.get(term) ?? 1 }));

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
      const result = this.scoreFile(file, weightedTerms, { recent, wantsRecent, entries, wantsEntry, wantsTests });
      if (result && result.score > 0) {
        scored.push(result);
      }
    }

    this.applyGraphProximity(scored);
    scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const shortlisted = scored.slice(0, Math.max(options.maxResults, 1));

    // Index-only mode ranks more targets than the snippet mode could afford,
    // because a `path:line` line costs a fraction of a code block. It is still a
    // shortlist, not an inventory: an agent picks from the top handful, and a
    // 48-item list only buries the answer and blows the budget.
    //
    // In this mode no file body is read at all: building the snippet items first
    // and discarding them would pay for disk reads the answer never uses.
    const rankedLimit = Math.min(Math.max(options.maxResults * 2, 12), 24);
    const ranked = scored.slice(0, Math.max(rankedLimit, Math.max(options.maxResults, 1)));
    const finalItems: ContextItem[] = options.symbolsOnly
      ? ranked.map((candidate) => this.toIndexItem(candidate))
      : await this.buildSnippetItems(shortlisted, options);

    const render = options.symbolsOnly ? renderIndexItem : renderItem;
    const budget = new TokenBudget(options.maxTokens, this.estimator);
    const kept: ContextItem[] = [];
    for (const item of finalItems) {
      const rendered = render(item, kept.length + 1);
      if (!budget.tryAdd(`${rendered}\n`)) {
        // Index items carry no snippet, so there is nothing cheaper to fall back
        // to: the item simply does not fit and neither will the ones after it.
        if (options.symbolsOnly) {
          break;
        }
        item.snippet = undefined;
        const withoutSnippet = render(item, kept.length + 1);
        if (!budget.tryAdd(`${withoutSnippet}\n`)) {
          break;
        }
        kept.push(item);
        continue;
      }
      kept.push(item);
    }

    const truncated = kept.length < finalItems.length;
    if (truncated) {
      warnings.push(
        `The token budget (${options.maxTokens}) was reached after ${kept.length} of ${finalItems.length} ranked hits. Narrow the query or the scope to see the rest.`
      );
    }
    if (kept.length === 0 && finalItems.length === 0) {
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
      durationMs: this.clock.now() - startedAt,
      mode: options.symbolsOnly ? 'index' : 'snippets'
    };
  }

  private scoreFile(
    file: FileRecord,
    weightedTerms: WeightedTerm[],
    context: { recent: Set<string>; wantsRecent: boolean; entries: Set<string>; wantsEntry: boolean; wantsTests: boolean }
  ): ScoredFile | undefined {
    const reasons: string[] = [];
    const matchedSymbols: SymbolRecord[] = [];
    let symbolMatchesInFile = 0;
    let score = 0;
    // Distinct query terms this file actually matches. Two specific terms in one
    // file is a stronger signal than one specific term, which a pure sum of
    // per-term scores cannot express.
    let coveredTerms = 0;
    const terms = weightedTerms.map((entry) => entry.term);
    const weightOf = new Map(weightedTerms.map((entry) => [entry.term, entry.weight] as const));
    const weight = (term: string): number => weightOf.get(term) ?? 1;
    const lowerPath = file.path.toLowerCase();
    const fileName = baseName(file.path).toLowerCase();
    const pathTerms = new Set(splitIdentifier(file.path));
    const names = nameTerms(terms);
    const fileTerms = fileTermsOf(file);

    for (const term of terms) {
      if (fileName === term) {
        score += 14 * weight(term);
        coveredTerms += 1;
        reasons.push(`file name is exactly "${term}"`);
        continue;
      }
      if (pathTerms.has(term)) {
        score += 6 * weight(term);
        coveredTerms += 1;
        reasons.push(`path contains "${term}"`);
        continue;
      }
      if (lowerPath.includes(term) && term.length >= 3) {
        score += 3 * weight(term);
        reasons.push(`path matches "${term}"`);
      }
    }

    for (const symbol of file.symbols) {
      for (const term of names) {
        const match = matchSymbolTerm(symbol, term);
        if (!match) {
          continue;
        }
        // One symbol keeps only its best match: scoring every term separately would
        // let a long query pile up points on a single coincidental name.
        //
        // Extra matched symbols count with diminishing returns. Without this, a
        // route table with 270 declarations outranks the one service the query
        // names, purely because more of its symbols happen to contain a word -
        // the file that "contains" a term should not beat the file that *is*
        // about it.
        score += match.weight * weight(term) * symbolMatchDecay(symbolMatchesInFile);
        symbolMatchesInFile += 1;
        // Only a name-level match counts towards term coverage. A signature or
        // doc mention is a hint about the file, not evidence that the file *is*
        // about the term, and a 270-route table mentions almost every word in
        // somebody's signature.
        if (match.kind === 'exact-name' || match.kind === 'segment-name' || match.kind === 'qualified-name' || match.kind === 'prefix-name') {
          coveredTerms += 1;
        }
        // A symbol named after the file it lives in is what the query is usually
        // after: `adminAuth` among 27 `*admin*` routes should win.
        if (fileTerms.has(term)) {
          score += TERM_FILE_AFFINITY * weight(term);
          reasons.push(`symbol ${symbol.name} (${symbol.kind}) is named after its own file`);
        } else {
          reasons.push(`symbol ${symbol.name} (${symbol.kind}) ${describeMatch(match.kind)} "${term}"`);
        }
        matchedSymbols.push(symbol);
        break;
      }
      for (const term of terms) {
        if (term.length >= 4 && `${symbol.doc ?? ''}`.toLowerCase().includes(term)) {
          score += 1 * weight(term);
          break;
        }
      }
    }

    for (const importRecord of file.imports) {
      const specifier = importRecord.specifier.toLowerCase();
      for (const term of terms) {
        if (term.length >= 4 && specifier.includes(term)) {
          score += 2.5 * weight(term);
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
        score += SYMBOL_KIND_BONUS;
        if (!matchedSymbols.includes(symbolKindMatch)) {
          matchedSymbols.push(symbolKindMatch);
        }
        reasons.push(hint.reason);
      }
      // A symbol whose declaration kind is exactly what the query asked for
      // ("route", "table", "component") should outrank one matched by name alone.
      if (matchedSymbols.some((symbol) => hint.symbolKinds.includes(symbol.kind))) {
        score += SYMBOL_KIND_BONUS;
        reasons.push(`a matched symbol is a ${hint.symbolKinds.join('/')}`);
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

    // Breadth on top of depth: a file that answers several of the query's words
    // (audit + log) is more likely the target than one that answers a single
    // frequent word well (service). Only *strong* matches count towards breadth -
    // a route table that merely mentions many words in its signatures must not
    // buy coverage this way, or breadth becomes the same volume problem again.
    // Capped so a file cannot climb on coverage alone.
    if (coveredTerms >= 2) {
      score += Math.min(coveredTerms, 5) * COVERAGE_BONUS;
      reasons.push(`matches ${coveredTerms} of the query's terms`);
    }

    if (score <= 0) {
      return undefined;
    }
    return { file, score, reasons: dedupe(reasons).slice(0, 4), matchedSymbols };
  }

  /**
   * Rarity weight per query term: how many indexed files mention the term.
   *
   * Computed once per query (one pass over the index) rather than per file, so
   * the cost stays linear. A term that appears everywhere ("service") is worth
   * little; a term that appears in a handful of files ("audit", "refund") is
   * worth much more. This is what keeps a long natural-language query from
   * being dominated by its most common words.
   */
  private termWeights(terms: string[], scopePrefix: string | undefined, includeTests: boolean): Map<string, number> {
    const counts = new Map<string, number>();
    for (const term of terms) {
      counts.set(term, 0);
    }

    let filesConsidered = 0;
    for (const file of this.index.allFiles()) {
      if (scopePrefix && !isInside(scopePrefix, file.path)) {
        continue;
      }
      if (!includeTests && file.kind === 'test') {
        continue;
      }
      filesConsidered += 1;

      const haystack = [
        file.path.toLowerCase(),
        ...splitIdentifier(file.path).map((part) => part.toLowerCase()),
        ...file.symbols.map((symbol) => `${symbol.name} ${symbol.signature ?? ''}`.toLowerCase()),
        ...file.imports.map((importRecord) => importRecord.specifier.toLowerCase())
      ].join(' ');

      for (const term of terms) {
        // Counted with the same "does it appear at all" test the scorer uses,
        // so the weight and the score agree about what counts as a match.
        if (haystack.includes(term)) {
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
    }

    const weights = new Map<string, number>();
    for (const term of terms) {
      const frequency = counts.get(term) ?? 0;
      weights.set(term, idfWeight(frequency, filesConsidered));
    }
    return weights;
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

  /**
   * Cheap phase-one item: the path, the matched symbol names and their line numbers,
   * but no file content. Reading nine snippets to use the tenth is the single most
   * expensive habit `bce_find_context` could encourage.
   */
  private async buildSnippetItems(candidates: ScoredFile[], options: RetrieveOptions): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    for (const candidate of candidates) {
      items.push(await this.toContextItem(candidate, options));
    }
    return items;
  }

  private toIndexItem(candidate: ScoredFile): ContextItem {
    const matched = candidate.matchedSymbols.slice(0, 4);
    return {
      path: candidate.file.path,
      language: candidate.file.language,
      kind: candidate.file.kind,
      score: Math.round(candidate.score * 10) / 10,
      reasons: candidate.reasons,
      symbols: matched.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        signature: symbol.signature,
        confidence: symbol.confidence
      })),
      ranges: matched.length > 0
        ? matched.map((symbol) => ({ start: symbol.line, end: symbol.line }))
        : [{ start: 1, end: 1 }],
      tests: candidate.file.tests,
      confidence: candidate.file.confidence
    };
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

/** Turns a match kind into the phrase the `why:` line uses. */
function describeMatch(kind: SymbolMatchKind): string {
  switch (kind) {
    case 'exact-name':
      return 'is exactly';
    case 'segment-name':
      return 'has the word';
    case 'qualified-name':
      return 'contains the qualified part';
    case 'prefix-name':
      return 'starts with';
    case 'substring-name':
      return 'contains';
    case 'signature':
      return 'mentions in its signature';
    case 'doc':
      return 'mentions in its doc';
  }
}

/**
 * Rendering for the phase-one (`symbolsOnly`) list.
 *
 * This is a `path:line` index, not a context bundle, so it must stay cheap: one
 * line per hit plus the matched symbol locations. Printing the full `why:` and
 * `symbols:` blocks for ~48 hits produced 16 KB answers that had to be written
 * to a temp file instead of read - the opposite of the point.
 */
export function renderIndexItem(item: ContextItem, index: number): string {
  const header = `${index}. ${item.path} [${item.language}${item.kind === 'source' ? '' : `, ${item.kind}`}] score ${item.score}`;
  const locations = item.symbols
    .slice(0, 3)
    .map((symbol) => `${symbol.name}${symbol.line ? `:${symbol.line}` : ''}`)
    .join(', ');
  const rest = item.symbols.length > 3 ? ` (+${item.symbols.length - 3} more)` : '';
  const why = item.reasons[0] ? ` - ${item.reasons[0]}` : '';
  return locations === '' ? `${header}${why}` : `${header}\n   ${locations}${rest}${why}`;
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
    lines.push(bundle.mode === 'index' ? renderIndexItem(item, index + 1) : renderItem(item, index + 1));
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
