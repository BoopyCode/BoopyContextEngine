import {
  DatabaseSchemaEntry,
  FileRecord,
  IndexFreshness,
  ProjectMap,
  SymbolRecord
} from './types';
import { isAbsoluteLike, escapesRoot, normalizeRel, toPosix } from './util/paths';
import { defaultTokenEstimator, TokenEstimator } from './util/tokens';
import { FileSystemLike } from './io/fs';
import { DocumentSnapshot, noOpenDocuments, OpenDocumentProvider } from './io/documents';
import { IgnoreDecision, IgnoreEngine } from './ignore/ignoreEngine';
import { ParserRegistry } from './parse/registry';
import { ImportResolver } from './parse/resolve';
import { classifyFile, detectLanguage } from './parse/languages';
import { ProjectIndex } from './index/indexModel';
import { ProjectIndexer } from './index/projectIndexer';
import { ContextCache } from './cache/contextCache';
import { Metrics } from './diagnostics/metrics';
import { UsageLedger } from './diagnostics/usageLedger';
import { GitClient, RecentChanges } from './vcs/git';
import { ContextBundle, ContextRetriever, RetrieveOptions } from './retrieve/contextRetriever';
import { LineRange, renderSnippet } from './retrieve/snippets';
import { WorkspaceConfig, clampTokenBudget, maxFileSizeBytes } from './config';
import { describeIndexErrors } from './map/projectMap';
import { hashContent } from './util/hash';

export interface ImpactReference {
  path: string;
  line: number;
  kind: string;
  confidence: string;
}

export interface ImpactCoverage {
  /** Internal (workspace) imports the parser saw: resolved plus unresolved. */
  internalImports: number;
  /** Internal imports the resolver could not link to a file. */
  unresolvedInternalImports: number;
  /** Files affected by at least one unresolved internal import. */
  filesWithUnresolvedImports: number;
  /** Share of internal imports that were linked, 0-100. */
  linkedPercent: number;
}

export interface ImpactReport {
  target: { kind: 'file' | 'symbol'; path?: string; symbol?: string };
  /**
   * False when the requested symbol or class could not be located. The empty lists
   * in such a report are "not analysed", never "no dependents".
   */
  resolved: boolean;
  verified: ImpactReference[];
  dependents: { path: string; reason: string }[];
  heuristics: { path: string; reason: string }[];
  tests: string[];
  relatedDatabase: DatabaseSchemaEntry[];
  warnings: string[];
  coverage: ImpactCoverage;
  indexVersion: number;
  freshness: IndexFreshness;
}

const CLASS_LIKE_KINDS: ReadonlySet<SymbolRecord['kind']> = new Set([
  'class',
  'interface',
  'trait',
  'enum',
  'type'
]);

export interface RelatedTestsReport {
  target: { path?: string; symbol?: string };
  tests: { path: string; reason: string; confidence: string; testedPath?: string }[];
  testConfigFiles: string[];
  runnerHints: string[];
  warnings: string[];
  indexVersion: number;
}

export interface PathResolution {
  ok: boolean;
  relPath?: string;
  error?: string;
  decision?: IgnoreDecision;
}

/**
 * High level, fully local "project intelligence" facade for one workspace folder.
 *
 * It is deliberately free of `vscode` imports: the extension host only adapts
 * settings, the file system and the tool wrappers to it, which keeps the whole
 * behavior testable without an Extension Host.
 */
export class WorkspaceIntelligence {
  private readonly estimator: TokenEstimator;
  private readonly retriever: ContextRetriever;
  private recentCache?: { at: number; value: RecentChanges };
  private mapVersion = -1;
  private mapCache?: ProjectMap;

  constructor(
    private readonly deps: {
      rootName: string;
      rootDisplayPath: string;
      fs: FileSystemLike;
      ignore: IgnoreEngine;
      indexer: ProjectIndexer;
      metrics: Metrics;
      contextCache: ContextCache<unknown>;
      config: WorkspaceConfig;
      git?: GitClient;
      estimator?: TokenEstimator;
      clock?: { now(): number };
      /** Supplies unsaved editor buffers so tool output never shows stale code. */
      documents?: OpenDocumentProvider;
      /** Needed to re-parse unsaved buffers so symbol lookups stay accurate. */
      parsers?: ParserRegistry;
      /** Append only log of tool calls and their estimated naive baseline. */
      usage?: UsageLedger;
    }
  ) {
    this.estimator = deps.estimator ?? defaultTokenEstimator;
    this.retriever = new ContextRetriever(deps.indexer.getIndex(), {
      readFile: (path) => this.readTextForContext(path),
      estimator: this.estimator,
      clock: deps.clock
    });
  }

  private get documents(): OpenDocumentProvider {
    return this.deps.documents ?? noOpenDocuments;
  }

  get config(): WorkspaceConfig {
    return this.deps.config;
  }

  get rootName(): string {
    return this.deps.rootName;
  }

  get index(): ProjectIndex {
    return this.deps.indexer.getIndex();
  }

  get indexer(): ProjectIndexer {
    return this.deps.indexer;
  }

  get metrics(): Metrics {
    return this.deps.metrics;
  }

  /** Undefined when the caller did not wire a log (core tests, disabled logging). */
  get usage(): UsageLedger | undefined {
    return this.deps.usage;
  }

  getFreshness(): IndexFreshness {
    return this.deps.indexer.getFreshness();
  }

  getMap(): ProjectMap {
    if (!this.mapCache || this.mapVersion !== this.index.indexVersion) {
      this.mapCache = this.deps.indexer.getMap();
      this.mapVersion = this.index.indexVersion;
    }
    return this.mapCache;
  }

  /**
   * Reads an indexed file, refusing anything the ignore engine blocks.
   * Falls back to the string-only form of `readTextForContext`.
   */
  async readFile(relPath: string): Promise<string | undefined> {
    const result = await this.readTextForContext(relPath);
    return result?.text;
  }

  /**
   * Reads file content for tool output, preferring the open editor buffer.
   *
   * `readFile` alone would return stale code for a file with unsaved changes, so an
   * open dirty buffer always wins over the disk copy. Disk hashes used by the index
   * are unaffected.
   */
  async readTextForContext(relPath: string): Promise<{ text: string; dirty: boolean; version?: number } | undefined> {
    const resolution = this.resolvePath(relPath);
    const target = resolution.relPath;
    if (!resolution.ok || !target) {
      return undefined;
    }
    const open = this.documents.get(target);
    if (open?.dirty) {
      return { text: open.text, dirty: true, version: open.version };
    }
    try {
      const stats = await this.deps.fs.stat(target);
      if (stats.size > maxFileSizeBytes(this.deps.config)) {
        return undefined;
      }
      const real = await this.deps.fs.resolveWithinRoot(target).catch(() => target);
      if (real !== target && !this.index.has(real)) {
        return undefined;
      }
      return { text: await this.deps.fs.readText(target), dirty: false };
    } catch {
      return undefined;
    }
  }

  /** Open buffers with unsaved changes, inside this workspace folder. */
  dirtyDocuments(): DocumentSnapshot[] {
    return this.documents.dirtyDocuments();
  }

  /**
   * Fingerprint of the editor state. Unsaved edits change tool output without changing
   * the index, so the context cache key has to include them.
   */
  dirtyFingerprint(): string {
    const dirty = this.dirtyDocuments();
    if (dirty.length === 0) {
      return 'clean';
    }
    return hashContent(
      dirty
        .map((document) => `${document.relPath}:${document.version}`)
        .sort()
        .join('|')
    ).slice(0, 16);
  }

  /**
   * Turns a user supplied path (absolute or workspace relative) into a safe
   * workspace-relative path, rejecting escapes and excluded files.
   */
  resolvePath(input: string): PathResolution {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return { ok: false, error: 'A non-empty path is required.' };
    }
    const trimmed = input.trim();
    let relPath: string;
    if (isAbsoluteLike(trimmed)) {
      const root = toPosix(this.deps.rootDisplayPath).replace(/\/+$/, '');
      const candidate = toPosix(trimmed);
      const rootLower = root.toLowerCase();
      const candidateLower = candidate.toLowerCase();
      if (candidateLower === rootLower) {
        return { ok: false, error: 'The path must point at a file inside the workspace, not at the workspace root.' };
      }
      if (!candidateLower.startsWith(`${rootLower}/`)) {
        return { ok: false, error: `Refusing to access "${input}": it is outside the workspace root.` };
      }
      relPath = normalizeRel(candidate.slice(root.length + 1));
    } else {
      relPath = normalizeRel(trimmed);
      if (relPath === '') {
        return { ok: false, error: `Could not normalize the path "${input}".` };
      }
      if (escapesRoot(trimmed)) {
        return { ok: false, error: `Refusing to access "${input}": the path leaves the workspace root.` };
      }
    }
    const decision = this.deps.ignore.check(relPath);
    if (decision.ignored) {
      return {
        ok: false,
        relPath,
        decision,
        error: `"${relPath}" is not available to BCE: ${decision.reason} (${decision.source}).`
      };
    }
    return { ok: true, relPath, decision };
  }

  /** Looks up a file record, or reuses the resolution to look it up by input path. */
  fileRecord(input: string): { record?: FileRecord; error?: string } {
    const resolution = this.resolvePath(input);
    if (!resolution.ok || !resolution.relPath) {
      return { error: resolution.error };
    }
    const record = this.index.get(resolution.relPath);
    if (!record) {
      return {
        error: `"${resolution.relPath}" is not part of the current index. It may be ignored, larger than bce.maxFileSizeKb, or created after the last index update (try bce_get_status).`
      };
    }
    return { record };
  }

  async retrieve(options: RetrieveOptions): Promise<ContextBundle> {
    const freshness = this.getFreshness();
    const result = await this.retriever.retrieve(options, freshness);
    this.deps.metrics.observeTiming('search.lastMs', result.durationMs);
    this.deps.metrics.setCounter('search.lastResults', result.items.length);
    this.deps.metrics.setCounter('search.lastEstimatedTokens', result.estimatedTokens);
    return result;
  }

  /** Cached variant of `retrieve`; the key includes the index version and editor state. */
  async retrieveCached(options: RetrieveOptions): Promise<{ bundle: ContextBundle; fromCache: boolean }> {
    const key = this.deps.contextCache.makeKey({
      tool: 'bce_find_context',
      indexVersion: this.index.indexVersion,
      configSignature: this.configSignature(),
      query: options.query,
      options: {
        scope: options.scope,
        maxTokens: options.maxTokens,
        includeTests: options.includeTests,
        includeSnippets: options.includeSnippets,
        symbolsOnly: options.symbolsOnly,
        maxResults: options.maxResults,
        snippetLines: options.snippetLines,
        // Unsaved editor buffers change snippets without changing the index version.
        dirty: this.dirtyFingerprint()
      }
    });
    // The ranking depends on the whole index, so the fingerprint is the index
    // version: any change to any file invalidates it.
    const fingerprint = (path: string): string | undefined =>
      path === '__index__' ? String(this.index.indexVersion) : this.index.get(path)?.hash;
    const cached = this.deps.contextCache.get(key, fingerprint) as ContextBundle | undefined;
    if (cached) {
      this.deps.metrics.increment('cache.l2.hit');
      return { bundle: { ...cached, durationMs: 0, warnings: cached.warnings }, fromCache: true };
    }
    this.deps.metrics.increment('cache.l2.miss');
    const bundle = await this.retrieve(options);
    this.deps.contextCache.set(key, { __index__: String(this.index.indexVersion) }, bundle);
    return { bundle, fromCache: false };
  }

  configSignature(): string {
    return this.index.configSignature;
  }

  async recentChanges(): Promise<RecentChanges> {
    if (!this.deps.git) {
      return { available: false, reason: 'git support is disabled for this workspace', changedPaths: [] };
    }
    const now = this.deps.clock?.now() ?? Date.now();
    if (this.recentCache && now - this.recentCache.at < 60000) {
      return this.recentCache.value;
    }
    const value = await this.deps.git.recentChanges(this.deps.config.recencyDays);
    this.recentCache = { at: now, value };
    return value;
  }

  async buildImpactReport(input: { path?: string; symbol?: string }): Promise<ImpactReport> {
    const warnings: string[] = [];
    const coverage = this.impactCoverage();
    const notAnalysed = (reason: string): ImpactReport => ({
      target: { kind: 'symbol', path: input.path, symbol: input.symbol?.trim() },
      resolved: false,
      verified: [],
      dependents: [],
      heuristics: [],
      tests: [],
      relatedDatabase: [],
      warnings: [reason],
      coverage,
      indexVersion: this.index.indexVersion,
      freshness: this.getFreshness()
    });

    let targetPath: string | undefined;
    let symbolName = input.symbol?.trim();
    let symbol: SymbolRecord | undefined;

    // `Class::method` is what people naturally type. The symbol table is keyed by
    // the bare name, so accepting the qualified form must resolve it properly -
    // silently answering about some other `method`, or about the whole file, is
    // how a confident report ends up describing a different question.
    let qualifier: string | undefined;
    if (symbolName && symbolName.includes('::')) {
      const [container, ...rest] = symbolName.split('::');
      qualifier = container.trim() || undefined;
      symbolName = rest.join('::').trim() || undefined;
    }

    if (qualifier) {
      const containerMatch = this.index.findBySymbol(qualifier).find((match) => CLASS_LIKE_KINDS.has(match.symbol.kind));
      if (!containerMatch) {
        return notAnalysed(
          `Class "${qualifier}" is not present in the index, so "${symbolName ?? qualifier}" was not analysed. ` +
            'Use the bare member name, or "path" for file level impact.'
        );
      }
      targetPath = containerMatch.file.path;
      if (symbolName) {
        symbol = containerMatch.file.symbols.find(
          (candidate) => candidate.name.toLowerCase() === symbolName?.toLowerCase()
        );
        if (!symbol) {
          return notAnalysed(
            `"${qualifier}" has no member named "${symbolName}" in ${targetPath}, so nothing was analysed. ` +
              'An empty result here is "not found", not "no dependents".'
          );
        }
      } else {
        symbol = containerMatch.symbol;
        symbolName = containerMatch.symbol.name;
      }
    } else if (input.path) {
      const resolved = this.fileRecord(input.path);
      if (resolved.error) {
        return {
          target: { kind: 'file', path: input.path },
          resolved: false,
          verified: [],
          dependents: [],
          heuristics: [],
          tests: [],
          relatedDatabase: [],
          warnings: [resolved.error],
          coverage,
          indexVersion: this.index.indexVersion,
          freshness: this.getFreshness()
        };
      }
      targetPath = resolved.record?.path;
      if (symbolName) {
        symbol = resolved.record?.symbols.find((candidate) => candidate.name.toLowerCase() === symbolName?.toLowerCase());
        if (!symbol) {
          return notAnalysed(
            `Symbol "${symbolName}" was not found in ${targetPath ?? input.path}, so nothing was analysed. ` +
              'An empty result here is "not found", not "no dependents". Pass "path" alone for file level impact.'
          );
        }
      }
    } else if (symbolName) {
      const matches = this.index.findBySymbol(symbolName);
      if (matches.length === 0) {
        return {
          target: { kind: 'symbol', symbol: symbolName },
          resolved: false,
          verified: [],
          dependents: [],
          heuristics: [],
          tests: [],
          relatedDatabase: [],
          warnings: [
            `Symbol "${symbolName}" is not present in the index. It may be new, ignored or defined dynamically. ` +
              'An empty result here is "not found", not "no dependents".'
          ],
          coverage,
          indexVersion: this.index.indexVersion,
          freshness: this.getFreshness()
        };
      }
      const first = matches[0];
      targetPath = first.file.path;
      symbol = first.symbol;
      symbolName = first.symbol.name;
      if (matches.length > 1) {
        warnings.push(`Symbol "${symbolName}" is defined in ${matches.length} files (${matches.map((match) => match.file.path).join(', ')}); the first one is analyzed.`);
      }
    }

    const map = this.getMap();
    const definitionPaths = new Set(symbolName ? this.index.findBySymbol(symbolName).map((match) => match.file.path) : targetPath ? [targetPath] : []);

    const verified: ImpactReference[] = [];
    if (symbolName) {
      const seen = new Set<string>();
      for (const reference of this.index.referencesTo(symbolName)) {
        if (definitionPaths.has(reference.path) && reference.line === symbol?.line) {
          continue;
        }
        // One line can reference the same symbol several times (call + type); keep the
        // strongest evidence and drop the duplicates.
        const key = `${reference.path}:${reference.line}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        verified.push(reference);
      }
    }

    const dependents: { path: string; reason: string }[] = [];
    const heuristics: { path: string; reason: string }[] = [];
    if (targetPath) {
      for (const file of this.index.reverseDependencies(targetPath)) {
        dependents.push({ path: file.path, reason: `imports ${targetPath}` });
      }
      for (const file of this.index.filesUnder('')) {
        if (file.path === targetPath || dependents.some((entry) => entry.path === file.path)) {
          continue;
        }
        if (symbolName && file.references.some((reference) => reference.name.toLowerCase() === symbolName?.toLowerCase())) {
          heuristics.push({ path: file.path, reason: `text match for "${symbolName}"` });
        }
      }
    }

    const tests = new Set<string>();
    if (targetPath) {
      const record = this.index.get(targetPath);
      for (const test of record?.tests ?? []) {
        tests.add(test);
      }
    }
    for (const reference of verified) {
      const record = this.index.get(reference.path);
      if (record?.kind === 'test') {
        tests.add(reference.path);
      }
    }

    const relatedDatabase = map.databaseSchema.tables.filter(
      (table) =>
        (symbolName && table.name.toLowerCase() === symbolName.toLowerCase()) ||
        table.references.some((reference) => reference === symbolName?.toLowerCase()) ||
        (targetPath && table.path === targetPath)
    );

    if (verified.length === 0 && symbolName) {
      const incomplete = coverage.unresolvedInternalImports > 0;
      warnings.push(
        incomplete
          ? `No parser verified reference to "${symbolName}" was found, and the import graph is incomplete ` +
              `(${coverage.unresolvedInternalImports} of ${coverage.internalImports} internal imports unresolved in ` +
              `${coverage.filesWithUnresolvedImports} file(s)). Verify with a text search before changing this code.`
          : `No parser verified reference to "${symbolName}"; the lists below are heuristics and must be checked in the files.`
      );
    }
    if (!symbolName && dependents.length === 0) {
      warnings.push('No importer of this file was found in the index. Dynamic loading (runtime include, DI container, route registration) is invisible to the parser.');
    }

    return {
      target: { kind: input.path ? 'file' : 'symbol', path: targetPath, symbol: symbolName },
      resolved: true,
      verified,
      dependents,
      heuristics,
      tests: [...tests],
      relatedDatabase,
      warnings,
      coverage,
      indexVersion: this.index.indexVersion,
      freshness: this.getFreshness()
    };
  }

  /**
   * Import-graph health of the current index.
   *
   * Every surface that shows ranked hits or dependents reports this: without it an
   * empty result caused by an unresolved import is indistinguishable from a real
   * finding - which is exactly how a broken index loses the trust of the agent
   * reading it.
   */
  impactCoverage(): ImpactCoverage {
    const namespaceRoots = this.index.declaredNamespaceRoots();
    let internalImports = 0;
    let unresolvedInternalImports = 0;
    const affected = new Set<string>();
    for (const file of this.index.allFiles()) {
      for (const importRecord of file.imports) {
        if (importRecord.resolved !== undefined) {
          internalImports += 1;
          continue;
        }
        if (!ImportResolver.isInternalSpecifier(importRecord.specifier, namespaceRoots)) {
          continue;
        }
        internalImports += 1;
        unresolvedInternalImports += 1;
        affected.add(file.path);
      }
    }
    const linked = internalImports - unresolvedInternalImports;
    return {
      internalImports,
      unresolvedInternalImports,
      filesWithUnresolvedImports: affected.size,
      linkedPercent: internalImports === 0 ? 100 : Math.round((linked / internalImports) * 100)
    };
  }

  async buildRelatedTestsReport(input: { path?: string; symbol?: string }): Promise<RelatedTestsReport> {
    const warnings: string[] = [];
    const found = new Map<string, { path: string; reason: string; confidence: string; testedPath?: string }>();
    const map = this.getMap();
    const add = (entry: { path: string; reason: string; confidence: string; testedPath?: string }): void => {
      if (!found.has(entry.path)) {
        found.set(entry.path, entry);
        return;
      }
      const existing = found.get(entry.path) as { path: string; reason: string; confidence: string; testedPath?: string };
      if (!existing.reason.includes(entry.reason)) {
        existing.reason = `${existing.reason}; ${entry.reason}`;
      }
    };

    let targetPath: string | undefined;
    let symbolName = input.symbol?.trim();

    if (input.path) {
      const resolved = this.fileRecord(input.path);
      if (resolved.error) {
        warnings.push(resolved.error);
      } else if (resolved.record) {
        targetPath = resolved.record.path;
        const record = resolved.record;
        for (const test of record.tests ?? []) {
          add({ path: test, reason: 'bound to this file by naming convention or import graph', confidence: 'heuristic' });
        }
        if ((record.tests ?? []).length === 0) {
          warnings.push('No test file is bound to this file yet. The candidates below are based on symbol usage only.');
        }
      }
    }

    if (symbolName) {
      const matches = this.index.findBySymbol(symbolName);
      if (matches.length === 0) {
        warnings.push(`Symbol "${symbolName}" is not in the index, so only test files that mention the name can be reported.`);
      } else if (!targetPath) {
        targetPath = matches[0].file.path;
        symbolName = matches[0].symbol.name;
      }
    }

    if (targetPath) {
      const base = targetPath.replace(/\.[^./]+$/, '').toLowerCase();
      for (const file of this.index.allFiles()) {
        if (file.kind !== 'test') {
          continue;
        }
        if (file.testedPath === targetPath) {
          add({ path: file.path, reason: 'bound to the target file', confidence: 'heuristic', testedPath: targetPath });
          continue;
        }
        const lower = file.path.toLowerCase();
        if (lower.includes(base) || file.dependencies.includes(targetPath)) {
          add({ path: file.path, reason: 'same base name or imports the target file', confidence: 'heuristic', testedPath: targetPath });
        }
      }
    }

    if (symbolName) {
      for (const reference of this.index.referencesTo(symbolName)) {
        const record = this.index.get(reference.path);
        if (record?.kind === 'test') {
          add({ path: reference.path, reason: `references "${symbolName}" at line ${reference.line}`, confidence: reference.confidence });
        }
      }
    }

    const tests = [...found.values()];
    if (tests.length === 0) {
      warnings.push('No related test file was found. When writing a new test, follow the conventions of the existing test directory and the runner configuration listed below.');
    }

    return {
      target: { path: targetPath ?? input.path, symbol: symbolName },
      tests,
      testConfigFiles: map.overview.testConfigFiles,
      runnerHints: describeTestRunners(map),
      warnings,
      indexVersion: this.index.indexVersion
    };
  }

  /** Re-parses an unsaved buffer so symbol lookups match the editor content. */
  private parseSymbols(relPath: string, content: string): SymbolRecord[] | undefined {
    const parsers = this.deps.parsers;
    if (!parsers) {
      return undefined;
    }
    const info = detectLanguage(relPath);
    if (info.parser === 'none') {
      return [];
    }
    try {
      const output = parsers.parse({ path: relPath, content, language: info.language, kind: classifyFile(relPath, info.language) }, info.parser);
      return output?.symbols;
    } catch {
      return undefined;
    }
  }

  status(verbose: boolean): string {
    const freshness = this.getFreshness();
    const index = this.index;
    const stats = index.getStats();
    const cacheStats = this.deps.contextCache.stats();
    const lines: string[] = [];
    lines.push(`BCE status for ${this.deps.rootName}`);
    lines.push(
      `index v${index.indexVersion}, ${index.size} file(s) indexed, ${stats.ignoredFiles || index.getIgnored().length} ignored, complete: ${index.complete}, partial: ${partialReason(index)}`
    );
    lines.push(
      `last update: ${index.indexedAt === 0 ? 'never' : new Date(index.indexedAt).toISOString()} (${Math.round(freshness.ageMs / 1000)} s ago), stale: ${freshness.stale}, indexing: ${freshness.indexing}, paused: ${freshness.paused}`
    );
    lines.push(
      `updates: ${index.getStats().updatedFiles} file(s) updated, ${index.getStats().removedFiles} removed, ${index.getStats().parseErrors} parse error(s), last run ${index.getStats().lastDurationMs} ms`
    );
    lines.push(
      `cache: parse entries ${index.parseCacheSize()}, context entries ${cacheStats.entries} (hits ${cacheStats.hits}, misses ${cacheStats.misses}, invalidations ${cacheStats.invalidations})`
    );
    lines.push(
      `safety: ${this.deps.ignore.respectGitignore ? '.gitignore respected' : '.gitignore ignored by setting'}, secrets and binary files always blocked, symlinks ${this.deps.config.followSymlinks ? 'followed inside the workspace' : 'not followed'}`
    );
    const coverage = this.impactCoverage();
    lines.push(
      `coverage: ${coverage.linkedPercent}% of internal imports linked ` +
        `(${coverage.unresolvedInternalImports}/${coverage.internalImports} unresolved in ${coverage.filesWithUnresolvedImports} file(s))` +
        (coverage.linkedPercent < 100
          ? ' - empty result lists are holes in the graph, not proof of absence'
          : '')
    );
    const dirty = this.dirtyDocuments();
    if (dirty.length > 0) {
      lines.push(
        `unsaved changes: ${dirty.length} open file(s) are not on disk and therefore not indexed; file reads use the editor content for ${dirty
          .slice(0, 5)
          .map((document) => document.relPath)
          .join(', ')}${dirty.length > 5 ? ', ...' : ''}`
      );
    } else {
      lines.push('unsaved changes: none (file reads come from disk)');
    }
    const unsaved = this.dirtyDocuments().length;
    if (unsaved > 0 && verbose) {
      lines.push('note: unsaved buffers are never written into the index; they only affect reads and snippets.');
    }
    if (index.getErrors().length > 0) {
      lines.push(`errors: ${describeIndexErrors(index.getErrors())}`);
      for (const error of index.getErrors().slice(0, verbose ? 10 : 3)) {
        lines.push(`  - ${error.path}: ${error.message}`);
      }
    } else {
      lines.push('errors: none');
    }
    const ignoredBySource = new Map<string, number>();
    for (const entry of index.getIgnored()) {
      ignoredBySource.set(entry.source, (ignoredBySource.get(entry.source) ?? 0) + 1);
    }
    if (ignoredBySource.size > 0) {
      lines.push(
        `ignored by: ${[...ignoredBySource.entries()]
          .map(([source, count]) => `${source}=${count}`)
          .join(', ')}`
      );
    }
    if (verbose) {
      const languages = mapLanguages(index);
      lines.push('');
      lines.push(`languages: ${languages}`);
      const pending = freshness.pendingPaths;
      if (pending.length > 0) {
        lines.push(`pending paths: ${pending.slice(0, 10).join(', ')}`);
      }
      const tools = this.deps.metrics.snapshot().tools;
      lines.push('');
      lines.push('tool usage this session:');
      for (const [tool, stat] of Object.entries(tools)) {
        lines.push(`  ${tool}: ${stat.calls} call(s), ~${stat.estimatedTokens} estimated tokens returned, ${stat.durationMs} ms, ${stat.errors} error(s)`);
      }
      if (Object.keys(tools).length === 0) {
        lines.push('  (no bce tool was called yet)');
      }
      const usage = this.deps.usage;
      if (usage) {
        const totals = usage.totals();
        lines.push('');
        lines.push(
          `estimated context avoided: ~${totals.savedTokens} token(s) across ${totals.callsWithBaseline} call(s) that have a naive baseline, ${usage.size} logged entr${
            usage.size === 1 ? 'y' : 'ies'
          }`
        );
        lines.push(
          usage.isPersisted
            ? `  saved in ${usage.file} inside BCE storage - run "BCE: Show Usage Report" to see it, "BCE: Reset Usage Log" to start over.`
            : '  logging is turned off by setting bce.usageLog.enabled, only this session is counted.'
        );
      }
      lines.push('');
      lines.push('note: token counts are local estimates, not the model provider billing numbers.');
    }
    return lines.join('\n');
  }

  /** Renders a single symbol or range of a file for `bce_get_file_context`. */
  async renderFileContext(
    relPath: string,
    target: { symbol?: string; startLine?: number; endLine?: number },
    maxTokens: number
  ): Promise<{ text: string; error?: string; estimatedTokens: number }> {
    const record = this.index.get(relPath);
    const source = await this.readTextForContext(relPath);
    if (source === undefined) {
      return { text: '', error: `"${relPath}" could not be read (excluded, missing or larger than bce.maxFileSizeKb).`, estimatedTokens: 0 };
    }
    const content = source.text;
    // With unsaved changes the indexed symbol table is stale, so re-parse the buffer
    // and resolve symbols against what the editor actually contains.
    const symbols = source.dirty ? this.parseSymbols(relPath, content) ?? record?.symbols ?? [] : record?.symbols ?? [];
    const budget = clampTokenBudget(maxTokens, this.deps.config.tokenBudget);
    const lines: string[] = [];
    const ranges: LineRange[] = [];
    let matched: SymbolRecord | undefined;

    if (target.symbol) {
      matched = symbols.find((symbol) => symbol.name.toLowerCase() === target.symbol?.toLowerCase());
      if (!matched) {
        const candidates = symbols
          .filter((symbol) => symbol.name.toLowerCase().includes(target.symbol?.toLowerCase() ?? ''))
          .slice(0, 8);
        return {
          text: '',
          error:
            candidates.length > 0
              ? `Symbol "${target.symbol}" was not found in ${relPath}. Similar symbols: ${candidates.map((symbol) => `${symbol.name} (L${symbol.line})`).join(', ')}.`
              : `Symbol "${target.symbol}" was not found in ${relPath}. Use bce_find_context to locate it.`,
          estimatedTokens: 0
        };
      }
      const end = matched.endLine ?? matched.line + this.deps.config.snippetLines;
      ranges.push({ start: matched.line, end });
    } else if (target.startLine !== undefined) {
      const end = target.endLine ?? target.startLine + this.deps.config.snippetLines;
      ranges.push({ start: target.startLine, end });
    } else {
      const head = symbols.filter((symbol) => symbol.kind !== 'column').slice(0, 4);
      if (head.length > 0) {
        ranges.push({ start: Math.max(1, head[0].line), end: Math.min(head[0].endLine ?? head[0].line + this.deps.config.snippetLines, head[0].line + this.deps.config.snippetLines) });
      } else {
        ranges.push({ start: 1, end: this.deps.config.snippetLines });
      }
    }

    lines.push(`file: ${relPath}`);
    if (source.dirty) {
      lines.push(
        `source: UNSAVED editor buffer (version ${source.version ?? 'unknown'}) - this is the code you see in the editor, not the file on disk; line numbers refer to the buffer.`
      );
    }
    if (record) {
      lines.push(
        `language: ${record.language}, kind: ${record.kind}, lines: ${content.split('\n').length}, dependencies: ${record.dependencies.length}, dependents: ${this.index.reverseDependencies(relPath).length}, confidence: ${record.confidence}`
      );
      if (record.imports.length > 0) {
        const resolved = record.imports.slice(0, 8).map((entry) => (entry.resolved ? `${entry.specifier} -> ${entry.resolved}` : entry.specifier));
        lines.push(`imports: ${resolved.join(', ')}`);
      }
      if (record.tests && record.tests.length > 0) {
        lines.push(`tests: ${record.tests.join(', ')}`);
      }
    } else {
      lines.push('note: this file is not part of the index (it may be ignored or created recently), showing raw lines only.');
    }
    if (matched) {
      lines.push(`symbol: ${matched.name} (${matched.kind}) L${matched.line}${matched.endLine ? `-${matched.endLine}` : ''}, confidence: ${matched.confidence}`);
      if (matched.doc) {
        lines.push(`doc: ${matched.doc}`);
      }
    }
    const header = [...lines];
    const assemble = (maxLines: number): { text: string; truncated: boolean } => {
      const snippet = renderSnippet(content, ranges, maxLines);
      const parts = [...header, 'code:', snippet.text];
      if (snippet.truncated) {
        parts.push('... (snippet shortened to fit the token budget; request a single symbol or a smaller range for the rest)');
      }
      return { text: parts.join('\n'), truncated: snippet.truncated };
    };

    // Shrink the slice until the whole payload fits the budget instead of failing.
    let maxLines = Math.max(6, Math.min(this.deps.config.snippetLines * 4, 400));
    let assembled = assemble(maxLines);
    while (this.estimator.estimate(assembled.text) > budget && maxLines > 6) {
      maxLines = Math.max(6, Math.floor(maxLines / 2));
      assembled = assemble(maxLines);
    }
    const estimatedTokens = this.estimator.estimate(assembled.text);
    if (estimatedTokens > budget) {
      return {
        text: `"${relPath}" could not be returned within the ${budget} token budget (~${estimatedTokens} ${this.estimator.method}). Request a single symbol or a smaller line range.`,
        error: 'token budget exceeded',
        estimatedTokens
      };
    }
    return { text: assembled.text, estimatedTokens };
  }
}

function partialReason(index: ProjectIndex): string {
  if (!index.partial) {
    return 'no';
  }
  const reasons: string[] = [];
  if (index.getStats().parseErrors > 0) {
    reasons.push(`${index.getStats().parseErrors} parse error(s)`);
  }
  if (index.getErrors().some((error) => error.message.includes('bce.maxFiles'))) {
    reasons.push('file limit reached');
  }
  return reasons.length > 0 ? reasons.join(', ') : 'yes';
}

function mapLanguages(index: ProjectIndex): string {
  const counts = new Map<string, number>();
  for (const file of index.allFiles()) {
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `${language} ${count}`)
    .join(', ');
}

function describeTestRunners(map: ProjectMap): string[] {
  const hints: string[] = [];
  for (const framework of map.overview.frameworks) {
    if (/vitest|jest|phpunit|pytest|playwright|cypress/i.test(framework.name)) {
      hints.push(`${framework.name} detected (${framework.evidence})`);
    }
  }
  for (const config of map.overview.testConfigFiles) {
    hints.push(`${config} present`);
  }
  return hints;
}
