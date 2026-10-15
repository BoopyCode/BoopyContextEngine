import {
  CacheableFileData,
  FileRecord,
  IndexError,
  IndexFreshness,
  IndexPhase,
  IndexProgress,
  IgnoredFile,
  ProjectMap
} from '../types';
import { CancellationLike, CancellationTokenSource, Clock, Debouncer, isCancelled, mapWithConcurrency, Scheduler, systemClock, systemScheduler, yieldToEventLoop } from '../util/async';
import { hashContent } from '../util/hash';
import { baseName } from '../util/paths';
import { FileNotFoundError, FileSystemLike } from '../io/fs';
import { IgnoreEngine } from '../ignore/ignoreEngine';
import { ProjectScanner, ScanOptions, ScannedFile, describeError } from '../scan/scanner';
import { ParserRegistry } from '../parse/registry';
import { ParseInput } from '../parse/parseTypes';
import { ImportResolver } from '../parse/resolve';
import { ProjectIndex } from './indexModel';
import { IndexStore, LoadResult } from './indexStore';
import { ProjectMapBuilder } from '../map/projectMap';
import { ContextCache } from '../cache/contextCache';
import { Metrics } from '../diagnostics/metrics';
import { classifyFile, detectLanguage, inferredTestedPath } from '../parse/languages';

export interface IndexerDeps {
  fs: FileSystemLike;
  store: IndexStore;
  parsers: ParserRegistry;
  createIgnoreEngine(): IgnoreEngine;
  scanOptions(): ScanOptions;
  metrics: Metrics;
  contextCache: ContextCache<unknown>;
  rootKey: string;
  rootName: string;
  configSignature(): string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  clock?: Clock;
  scheduler?: Scheduler;
  concurrency?: number;
  debounceMs?: number;
  maxDebounceMs?: number;
}

export interface IndexerState {
  phase: IndexPhase;
  progress: IndexProgress;
  freshness: IndexFreshness;
}

export type FileEventKind = 'change' | 'create' | 'delete' | 'rename';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_DEBOUNCE_MS = 3000;
/**
 * Files parsed before the indexer hands the event loop back. Parsing is CPU bound
 * and synchronous, so without this the Extension Host could stall UI updates during
 * a large scan.
 */
const YIELD_EVERY_FILES = 16;

/**
 * Owns the incremental index: initial load, background full scan, debounced
 * incremental updates driven by file events, cancellation, persistence and the
 * freshness/state reporting used by the status bar and the tools.
 */
export class ProjectIndexer {
  private readonly index = new ProjectIndex();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly concurrency: number;
  private readonly debouncer: Debouncer;
  private readonly pendingPaths = new Set<string>();
  private readonly mapBuilder: ProjectMapBuilder;
  private loading = false;
  private running = false;
  /** Set by `dispose()`: a disposed indexer must never touch the store again. */
  private disposed = false;
  /** Number of incremental updates in flight (full scans use `running`). */
  private inFlight = 0;
  private paused = false;
  private currentRun?: CancellationTokenSource;
  private phase: IndexPhase = 'idle';
  private progress: IndexProgress = { phase: 'idle', processed: 0, total: 0 };
  private projectMap?: ProjectMap;
  private mapVersion = -1;
  private staleSince?: number;
  private listeners: ((state: IndexerState) => void)[] = [];

  constructor(private readonly deps: IndexerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.scheduler = deps.scheduler ?? systemScheduler;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.mapBuilder = new ProjectMapBuilder(this.clock);
    this.debouncer = new Debouncer(
      deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      deps.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS,
      () => {
        void this.flushPending();
      },
      this.scheduler,
      this.clock
    );
    this.index.rootKey = deps.rootKey;
    this.index.rootName = deps.rootName;
    this.index.parserVersion = deps.parsers.version;
    this.index.configSignature = deps.configSignature();
  }

  onStateChange(listener: (state: IndexerState) => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      }
    };
  }

  getIndex(): ProjectIndex {
    return this.index;
  }

  getState(): IndexerState {
    return { phase: this.phase, progress: { ...this.progress }, freshness: this.getFreshness() };
  }

  getFreshness(): IndexFreshness {
    const pending = [...this.pendingPaths];
    return {
      complete: this.index.complete,
      partial: this.index.partial,
      stale: !this.index.complete || pending.length > 0 || this.staleSince !== undefined,
      paused: this.paused,
      indexing: this.running || this.loading || this.inFlight > 0,
      indexVersion: this.index.indexVersion,
      indexedAt: this.index.indexedAt,
      ageMs: this.index.indexedAt === 0 ? 0 : this.clock.now() - this.index.indexedAt,
      pendingPaths: pending.slice(0, 20),
      errors: this.index.getErrors().slice(0, 10)
    };
  }

  pendingCount(): number {
    return this.pendingPaths.size;
  }

  /** Current project map, rebuilt lazily when the index version changed. */
  getMap(): ProjectMap {
    if (!this.projectMap || this.mapVersion !== this.index.indexVersion) {
      this.projectMap = this.mapBuilder.build(this.index);
      this.mapVersion = this.index.indexVersion;
    }
    return this.projectMap;
  }

  /**
   * Loads a previous index (if compatible) and then brings it up to date.
   * `fullScan` forces a complete re-walk even when an index could be loaded.
   */
  async initialize(options: { fullScan?: boolean; loadOnly?: boolean; token?: CancellationLike } = {}): Promise<void> {
    if (this.disposed || this.loading) {
      return;
    }
    this.loading = true;
    try {
      const expectation = {
        rootKey: this.deps.rootKey,
        parserVersion: this.deps.parsers.version,
        configSignature: this.deps.configSignature()
      };
      const loaded: LoadResult = await this.deps.store.load(expectation);
      let needsFullScan = options.fullScan === true;

      if (loaded.status === 'loaded') {
        this.index.clear();
        const restored = loaded.index;
        for (const file of restored.allFiles()) {
          this.index.set(file);
        }
        this.index.indexVersion = restored.indexVersion;
        this.index.indexedAt = restored.indexedAt;
        this.index.complete = restored.complete;
        this.index.partial = restored.partial;
        this.index.setIgnored(restored.getIgnored());
        this.index.setErrors(restored.getErrors());
        this.index.setStats(restored.getStats());
        for (const [key, value] of restored.parseCacheEntries()) {
          this.index.setParseCacheEntry(key, value);
        }
        this.deps.metrics.increment('cache.l2.restored', Object.keys(loaded.contextCache).length);
        if (loaded.droppedContextCache) {
          this.deps.log('info', 'Settings changed since the last index, cached search results were discarded.');
        }
        this.deps.log('info', `Loaded index with ${this.index.size} file(s) from the previous session.`);
        if (expectation.configSignature !== restored.configSignature) {
          this.deps.log('info', 'Include/ignore settings changed, rebuilding the index.');
          needsFullScan = true;
        }
        this.index.configSignature = expectation.configSignature;
      } else {
        if (loaded.status === 'corrupt') {
          this.deps.log('warn', `Stored index was damaged and was moved aside: ${loaded.reason}`);
        } else if (loaded.status === 'incompatible') {
          this.deps.log('info', `Stored index is not reusable: ${loaded.reason}`);
        } else {
          this.deps.log('info', `No stored index: ${loaded.reason}`);
        }
        needsFullScan = true;
        this.index.clear();
      }

      if (isCancelled(options.token)) {
        return;
      }
      if (options.loadOnly) {
        if (loaded.status !== 'loaded') {
          this.deps.log('info', 'Automatic indexing is disabled and no usable stored index was found; BCE tools will report an incomplete index until bce.rebuildIndex runs.');
        }
        return;
      }
      if (needsFullScan) {
        await this.fullIndex(options.token);
      } else {
        this.staleSince = this.clock.now();
        await this.refreshPaths(this.index.paths(), options.token, true);
      }
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async fullIndex(token?: CancellationLike): Promise<void> {
    if (this.disposed) {
      this.deps.log('debug', 'The session was disposed, the indexing request was dropped.');
      return;
    }
    if (this.running) {
      this.deps.log('debug', 'Indexing is already running, the new request was ignored.');
      return;
    }
    const source = new CancellationTokenSource();
    this.currentRun = source;
    const effectiveToken: CancellationLike = combine(token, source.token);
    this.running = true;
    const startedAt = this.clock.now();
    this.setPhase('scanning', 0, 0);

    try {
      const scanner = new ProjectScanner(this.deps.fs, this.deps.createIgnoreEngine(), this.deps.scanOptions(), this.clock);
      const scan = await scanner.scan(effectiveToken, (progress) => {
        this.setProgress('scanning', progress.filesFound, 0, progress.currentDirectory);
      });
      this.deps.metrics.observeTiming('index.scanMs', this.clock.now() - startedAt);
      this.deps.metrics.setCounter('index.ignoredFiles', scan.ignoredCount);

      if (isCancelled(effectiveToken)) {
        this.deps.log('info', 'Indexing was cancelled during the scan, the previous index was kept.');
        this.setPhase('idle', 0, 0);
        return;
      }

      this.setPhase('indexing', 0, scan.files.length);
      const pathSet = new Set(scan.files.map((file) => file.path));
      const resolver = new ImportResolver(pathSet);
      let processed = 0;
      let updated = 0;
      let unchanged = 0;
      let parseErrors = 0;

      const previousRecords = new Map(this.index.allFiles().map((file) => [file.path, file] as const));
      const results = await mapWithConcurrency(
        scan.files,
        this.concurrency,
        async (scanned) => {
          const record = await this.buildRecord(scanned, previousRecords.get(scanned.path), resolver, effectiveToken, false);
          processed += 1;
          if (processed % 25 === 0 || processed === scan.files.length) {
            this.setProgress('indexing', processed, scan.files.length, scanned.path);
          }
          if (processed % YIELD_EVERY_FILES === 0) {
            this.deps.metrics.increment('index.yields');
            await yieldToEventLoop();
          }
          if (record.parseError) {
            parseErrors += 1;
          }
          if (record.changed) {
            updated += 1;
          } else {
            unchanged += 1;
          }
          return record.file;
        },
        effectiveToken
      );

      if (isCancelled(effectiveToken)) {
        this.deps.log('info', 'Indexing was cancelled, the previous index was kept.');
        this.setPhase('idle', 0, 0);
        return;
      }

      for (const path of this.index.paths()) {
        if (!pathSet.has(path)) {
          this.index.remove(path);
        }
      }
      for (const file of results) {
        this.index.set(file);
      }
      scrubDeletedDependencies(this.index, pathSet);
      this.bindTests();
      this.index.setIgnored(trimIgnored(scan.ignored));
      // Parser/read errors collected while building records must survive the scan
      // errors, otherwise a broken file would silently disappear from the report.
      const accumulatedErrors = this.index.getErrors();
      this.index.setErrors([...accumulatedErrors, ...scan.errors]);
      this.index.complete = true;
      this.index.partial = scan.truncated || parseErrors > 0;
      this.index.configSignature = this.deps.configSignature();
      this.index.bumpVersion(this.clock.now());
      this.staleSince = undefined;
      this.index.setStats({
        updatedFiles: updated,
        unchangedFiles: unchanged,
        removedFiles: Math.max(0, previousRecords.size - results.length),
        parseErrors,
        ignoredFiles: scan.ignoredCount,
        lastDurationMs: this.clock.now() - startedAt
      });
      this.deps.metrics.setCounter('index.files', this.index.size);
      this.deps.metrics.increment('index.fullScans');
      this.deps.metrics.observeTiming('index.fullMs', this.clock.now() - startedAt);

      // A cancelled or disposed pass must not write: the stored index stays as it was.
      if (this.disposed || isCancelled(effectiveToken)) {
        this.deps.log('info', 'Index results were not stored because the run was cancelled.');
        this.setPhase('idle', results.length, results.length);
        return;
      }
      await this.persist();
      this.setPhase('idle', results.length, results.length);
      this.deps.log('info', `Indexed ${this.index.size} file(s) in ${this.clock.now() - startedAt} ms (${updated} updated, ${unchanged} unchanged, ${parseErrors} parse error(s)).`);
    } catch (error) {
      this.setPhase('error', 0, 0);
      this.index.addError({ path: '.', message: `Indexing failed: ${describeError(error)}`, at: this.clock.now() });
      this.deps.metrics.increment('index.errors');
      this.deps.log('error', `Indexing failed: ${describeError(error)}`);
    } finally {
      this.running = false;
      this.currentRun = undefined;
      this.emit();
    }
  }

  /** Rebuilds everything, dropping both cache layers first. */
  async rebuild(token?: CancellationLike): Promise<void> {
    this.deps.contextCache.clear();
    this.index.clearParseCache();
    await this.deps.store.clearCaches().catch(() => undefined);
    this.deps.metrics.increment('cache.cleared');
    await this.fullIndex(token);
  }

  /** Updates the given paths (or removes missing ones). Used by file events and init. */
  async refreshPaths(paths: readonly string[], token?: CancellationLike, force = true): Promise<void> {
    if (this.disposed) {
      return;
    }
    const unique = [...new Set(paths.filter((path) => path.length > 0))];
    if (unique.length === 0) {
      return;
    }
    if (this.paused) {
      for (const path of unique) {
        this.pendingPaths.add(path);
      }
      this.emit();
      return;
    }

    const source = new CancellationTokenSource();
    this.currentRun = source;
    const effectiveToken: CancellationLike = token ? combine(token, source.token) : source.token;
    const startedAt = this.clock.now();
    this.inFlight += 1;
    this.setPhase('indexing', 0, unique.length);

    try {
      const resolver = new ImportResolver(new Set([...this.index.paths(), ...unique]));
      let processed = 0;
      let updated = 0;
      let removed = 0;
      let parseErrors = 0;
      const changedPaths: string[] = [];

      await mapWithConcurrency(
        unique,
        Math.min(this.concurrency, 4),
        async (path) => {
          processed += 1;
          this.setProgress('indexing', processed, unique.length, path);
          const existing = this.index.get(path);
          let fileStat;
          try {
            fileStat = await this.deps.fs.stat(path);
          } catch (error) {
            if (error instanceof FileNotFoundError) {
              if (this.index.remove(path)) {
                removed += 1;
                changedPaths.push(path);
              }
              return;
            }
            this.recordError(path, `Cannot stat file: ${describeError(error)}`);
            parseErrors += 1;
            return;
          }
          if (fileStat.isDirectory) {
            return;
          }
          if (fileStat.size > this.deps.scanOptions().maxFileSizeBytes) {
            this.deps.log('debug', `${path} is larger than bce.maxFileSizeKb and was skipped.`);
            if (this.index.remove(path)) {
              removed += 1;
              changedPaths.push(path);
            }
            return;
          }
          const scanned: ScannedFile = {
            path,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            ...detectForPath(path)
          };
          const result = await this.buildRecord(scanned, existing, resolver, effectiveToken, force);
          this.index.set(result.file);
          if (result.parseError) {
            parseErrors += 1;
          }
          if (result.changed) {
            updated += 1;
            changedPaths.push(path);
          }
        },
        effectiveToken
      );

      if (isCancelled(effectiveToken)) {
        this.deps.log('debug', 'Incremental update was cancelled.');
        this.setPhase('idle', processed, unique.length);
        return;
      }

      if (changedPaths.length > 0) {
        this.deps.contextCache.invalidatePaths(changedPaths);
        this.deps.metrics.increment('cache.l2.invalidated', changedPaths.length);
      }
      scrubDeletedDependencies(this.index, new Set(this.index.paths()));
      this.bindTests();
      const stats = this.index.getStats();
      this.index.setStats({
        updatedFiles: stats.updatedFiles + updated,
        removedFiles: stats.removedFiles + removed,
        parseErrors,
        lastDurationMs: this.clock.now() - startedAt
      });
      this.index.partial = this.index.partial || parseErrors > 0;
      this.index.bumpVersion(this.clock.now());
      if (this.pendingPaths.size === 0) {
        this.staleSince = undefined;
      }
      if (updated > 0 || removed > 0) {
        this.deps.metrics.increment('index.incrementalUpdates');
        if (this.disposed || isCancelled(effectiveToken)) {
          this.deps.log('info', 'Incremental results were not stored because the run was cancelled.');
        } else {
          await this.persist();
        }
        this.deps.log('debug', `Incremental update: ${updated} updated, ${removed} removed in ${this.clock.now() - startedAt} ms.`);
      }
      this.setPhase('idle', processed, unique.length);
    } catch (error) {
      this.setPhase('error', 0, 0);
      this.index.addError({ path: unique[0] ?? '.', message: `Incremental update failed: ${describeError(error)}`, at: this.clock.now() });
      this.deps.log('error', `Incremental update failed: ${describeError(error)}`);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.currentRun = undefined;
      this.emit();
    }
  }

  /**
   * Queues a file system event; rapid bursts are coalesced.
   *
   * Because the queue is a set of paths, a change that arrives while the same path is
   * still being indexed simply replaces the queued entry; if the pass is already
   * running, the flush is retried until it can run, so the newest content always wins.
   */
  handleFileEvent(kind: FileEventKind, relPath: string, previousPath?: string): void {
    if (this.disposed) {
      return;
    }
    if (relPath.length > 0) {
      this.pendingPaths.add(relPath);
    }
    if (previousPath && previousPath.length > 0) {
      this.pendingPaths.add(previousPath);
    }
    this.staleSince = this.staleSince ?? this.clock.now();
    this.deps.metrics.increment(`index.fileEvents.${kind}`);
    if (this.paused) {
      this.emit();
      return;
    }
    this.debouncer.trigger();
    this.emit();
  }

  private async flushPending(): Promise<void> {
    if (this.disposed || this.paused || this.pendingPaths.size === 0) {
      return;
    }
    if (this.running || this.loading || this.inFlight > 0) {
      // Another index pass is in progress; keep the paths queued and retry shortly.
      this.debouncer.trigger();
      return;
    }
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    this.setPhase('indexing', 0, paths.length);
    await this.refreshPaths(paths, undefined, true);
  }

  pause(): void {
    this.paused = true;
    this.debouncer.dispose();
    this.phase = 'paused';
    this.deps.log('info', 'Background indexing paused.');
    this.emit();
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.deps.log('info', 'Background indexing resumed.');
    if (this.pendingPaths.size > 0) {
      this.debouncer.trigger();
    } else {
      this.setPhase('idle', 0, 0);
    }
    this.emit();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Cancels the running scan or update; the last valid index is kept. */
  cancel(): boolean {
    if (!this.currentRun) {
      return false;
    }
    this.currentRun.cancel();
    this.deps.log('info', 'Cancellation requested, the last valid index is kept.');
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.debouncer.dispose();
    this.currentRun?.cancel();
    this.pendingPaths.clear();
    this.listeners.length = 0;
  }

  /** Waits until no indexing work is in flight (used by tests and shutdown). */
  async waitForIdle(timeoutMs = 20000): Promise<void> {
    const deadline = this.clock.now() + timeoutMs;
    while ((this.running || this.loading || this.inFlight > 0 || this.debouncer.pending) && this.clock.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async buildRecord(
    scanned: ScannedFile,
    previous: FileRecord | undefined,
    resolver: ImportResolver,
    token: CancellationLike,
    forceRead: boolean
  ): Promise<{ file: FileRecord; changed: boolean; parseError: boolean }> {
    const fastPath = !forceRead && previous && previous.mtimeMs === scanned.mtimeMs && previous.size === scanned.size;
    if (fastPath && previous) {
      this.deps.metrics.increment('cache.l1.fileSkipped');
      return { file: { ...previous, mtimeMs: scanned.mtimeMs }, changed: false, parseError: false };
    }

    let content: string;
    try {
      content = await this.deps.fs.readText(scanned.path);
    } catch (error) {
      this.recordError(scanned.path, `Cannot read file: ${describeError(error)}`);
      if (previous) {
        return { file: previous, changed: false, parseError: true };
      }
      return {
        file: emptyRecord(scanned, this.clock.now(), describeError(error)),
        changed: false,
        parseError: true
      };
    }
    if (isCancelled(token)) {
      return { file: previous ?? emptyRecord(scanned, this.clock.now()), changed: false, parseError: false };
    }

    const hash = hashContent(content);
    if (previous && previous.hash === hash) {
      this.deps.metrics.increment('cache.l1.hashMatch');
      return { file: { ...previous, mtimeMs: scanned.mtimeMs, size: scanned.size }, changed: false, parseError: false };
    }

    const parsed = this.parseWithCache(scanned, content, hash);
    if (parsed.error) {
      this.recordError(scanned.path, parsed.error);
      if (previous) {
        return { file: { ...previous, mtimeMs: scanned.mtimeMs, size: scanned.size, parseError: parsed.error }, changed: false, parseError: true };
      }
      return { file: { ...emptyRecord(scanned, this.clock.now(), parsed.error) }, changed: false, parseError: true };
    }

    const data = parsed.data as CacheableFileData;
    const dependencies: string[] = [];
    const imports = data.imports.map((importRecord) => {
      const resolved = resolver.resolve(scanned.path, importRecord.specifier);
      if (resolved && resolved.path !== scanned.path) {
        if (!dependencies.includes(resolved.path)) {
          dependencies.push(resolved.path);
        }
        return { ...importRecord, resolved: resolved.path };
      }
      return importRecord;
    });

    const record: FileRecord = {
      path: scanned.path,
      hash,
      size: scanned.size,
      mtimeMs: scanned.mtimeMs,
      language: data.language,
      kind: data.kind,
      symbols: data.symbols,
      imports,
      references: data.references,
      dependencies,
      confidence: data.confidence,
      facts: data.facts,
      indexedAt: this.clock.now()
    };
    return { file: record, changed: previous === undefined || previous.hash !== hash, parseError: false };
  }

  private parseWithCache(scanned: ScannedFile, content: string, hash: string): { data?: CacheableFileData; error?: string } {
    const key = `${this.deps.parsers.version}:${scanned.language}:${hash}`;
    const cached = this.index.getParseCacheEntry(key);
    if (cached) {
      this.deps.metrics.increment('cache.l1.hit');
      return { data: cached };
    }
    this.deps.metrics.increment('cache.l1.miss');
    const input: ParseInput = { path: scanned.path, content, language: scanned.language, kind: scanned.kind };
    if (scanned.parser === 'none') {
      const data: CacheableFileData = {
        language: scanned.language,
        kind: scanned.kind,
        symbols: [],
        imports: [],
        references: [],
        dependencies: [],
        confidence: 'exact'
      };
      this.index.setParseCacheEntry(key, data);
      return { data };
    }
    try {
      const output = this.deps.parsers.parse(input, scanned.parser);
      if (!output) {
        return { error: `no parser registered for ${scanned.parser}` };
      }
      const data: CacheableFileData = {
        language: output.language,
        kind: output.kind,
        symbols: output.symbols,
        imports: output.imports,
        references: output.references,
        dependencies: [],
        confidence: output.confidence,
        facts: output.facts
      };
      this.index.setParseCacheEntry(key, data);
      return { data };
    } catch (error) {
      return { error: `parser failed: ${describeError(error)}` };
    }
  }

  /**
   * Links tests to sources: naming convention first, then the import graph, then
   * symbol usage. Every link stays a heuristic candidate, never a guarantee.
   */
  /** Also guards against a symbol without a name, which would break every consumer. */
  private bindTests(): void {
    const files = this.index.allFiles();
    for (const file of files) {
      file.tests = undefined;
      file.testedPath = undefined;
    }
    const symbolsByOwner = new Map<string, Set<string>>();
    for (const file of files) {
      if (file.kind === 'test') {
        continue;
      }
      for (const symbol of file.symbols) {
        if (typeof symbol.name !== 'string' || symbol.name.length === 0) {
          continue;
        }
        const key = symbol.name.toLowerCase();
        const set = symbolsByOwner.get(key) ?? new Set<string>();
        set.add(file.path);
        symbolsByOwner.set(key, set);
      }
    }

    const testsBySource = new Map<string, string[]>();
    for (const file of files) {
      if (file.kind !== 'test') {
        continue;
      }
      let source = this.resolveTestedPath(file.path);
      if (!source) {
        const dependencies = file.dependencies.filter((dependency) => this.index.get(dependency)?.kind !== 'test');
        if (dependencies.length === 1) {
          source = dependencies[0];
        } else if (dependencies.length > 1) {
          source = dependencies.find((dependency) => baseName(dependency).toLowerCase().includes(baseName(file.path).toLowerCase().split('.')[0])) ?? dependencies[0];
        }
      }
      if (!source) {
        const candidates = new Map<string, number>();
        for (const reference of file.references) {
          if (typeof reference.name !== 'string') {
            continue;
          }
          for (const owner of symbolsByOwner.get(reference.name.toLowerCase()) ?? []) {
            candidates.set(owner, (candidates.get(owner) ?? 0) + 1);
          }
        }
        const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
        source = best?.[0];
      }
      if (!source) {
        continue;
      }
      file.testedPath = source;
      const list = testsBySource.get(source) ?? [];
      list.push(file.path);
      testsBySource.set(source, list);
    }
    for (const file of files) {
      const tests = testsBySource.get(file.path);
      if (tests && tests.length > 0) {
        file.tests = tests;
      }
    }
  }

  private resolveTestedPath(testPath: string): string | undefined {
    const candidate = inferredTestedPath(testPath);
    if (candidate && this.index.has(candidate)) {
      return candidate;
    }
    return undefined;
  }

  private recordError(path: string, message: string): void {
    const error: IndexError = { path, message, at: this.clock.now() };
    this.index.addError(error);
    this.deps.metrics.increment('index.parseErrors');
    this.deps.log('warn', `${path}: ${message}`);
  }

  private async persist(): Promise<void> {
    const result = await this.deps.store.save(this.index, this.deps.contextCache.snapshot());
    if (!result.ok) {
      this.deps.log('warn', `Index could not be persisted: ${result.reason}`);
      this.deps.metrics.increment('index.saveFailures');
      return;
    }
    this.deps.metrics.increment('index.saves');
    const map = this.getMap();
    const mapResult = await this.deps.store.saveMap(map);
    if (!mapResult.ok) {
      this.deps.log('warn', `Project map could not be persisted: ${mapResult.reason}`);
    }
  }

  private setPhase(phase: IndexPhase, processed: number, total: number): void {
    this.phase = phase;
    this.progress = { phase, processed, total, currentPath: this.progress.currentPath };
    this.emit();
  }

  private setProgress(phase: IndexPhase, processed: number, total: number, current?: string): void {
    this.phase = phase;
    this.progress = { phase, processed, total, currentPath: current };
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A broken listener must never break indexing.
      }
    }
  }
}

function detectForPath(path: string): { language: ScannedFile['language']; kind: ScannedFile['kind']; parser: ScannedFile['parser'] } {
  const info = detectLanguage(path);
  return { language: info.language, kind: classifyFile(path, info.language), parser: info.parser };
}

function combine(a: CancellationLike | undefined, b: CancellationLike): CancellationLike {
  return {
    get isCancellationRequested(): boolean {
      return (a?.isCancellationRequested ?? false) || b.isCancellationRequested;
    }
  };
}

function emptyRecord(scanned: ScannedFile, at: number, parseError?: string): FileRecord {
  return {
    path: scanned.path,
    hash: '',
    size: scanned.size,
    mtimeMs: scanned.mtimeMs,
    language: scanned.language,
    kind: scanned.kind,
    symbols: [],
    imports: [],
    references: [],
    dependencies: [],
    confidence: 'heuristic',
    indexedAt: at,
    parseError
  };
}

function scrubDeletedDependencies(index: ProjectIndex, existingPaths: Set<string>): void {
  for (const file of index.allFiles()) {
    if (file.dependencies.some((dependency) => !existingPaths.has(dependency))) {
      file.dependencies = file.dependencies.filter((dependency) => existingPaths.has(dependency));
      file.imports = file.imports.map((importRecord) =>
        importRecord.resolved && !existingPaths.has(importRecord.resolved) ? { ...importRecord, resolved: undefined } : importRecord
      );
    }
  }
}

function trimIgnored(ignored: IgnoredFile[], limit = 500): IgnoredFile[] {
  if (ignored.length <= limit) {
    return ignored;
  }
  return ignored.slice(0, limit);
}
