import { CacheableFileData, FileRecord, IgnoredFile, IndexError, IndexStats, PersistedIndex } from '../types';
import { SCHEMA_VERSION } from '../parse/registry';
import { dirOf, isInside } from '../util/paths';

const MAX_PARSE_CACHE_ENTRIES = 4000;

/**
 * In-memory project index with the lookup helpers used by the retriever and the
 * language model tools. It owns no I/O; persistence lives in `IndexStore`.
 */
export class ProjectIndex {
  private readonly files = new Map<string, FileRecord>();
  private readonly parseCache = new Map<string, CacheableFileData>();
  private ignored: IgnoredFile[] = [];
  private errors: IndexError[] = [];
  private stats: IndexStats = emptyStats();

  schemaVersion = SCHEMA_VERSION;
  parserVersion = '';
  indexVersion = 0;
  rootKey = '';
  rootName = '';
  configSignature = '';
  indexedAt = 0;
  complete = false;
  partial = false;

  get size(): number {
    return this.files.size;
  }

  getStats(): IndexStats {
    return { ...this.stats, indexedFiles: this.files.size, ignoredFiles: this.ignored.length };
  }

  setStats(stats: Partial<IndexStats>): void {
    this.stats = { ...this.stats, ...stats };
  }

  getIgnored(): IgnoredFile[] {
    return this.ignored;
  }

  setIgnored(ignored: IgnoredFile[]): void {
    this.ignored = ignored;
  }

  getErrors(): IndexError[] {
    return this.errors;
  }

  setErrors(errors: IndexError[]): void {
    this.errors = errors.slice(0, 200);
  }

  addError(error: IndexError): void {
    this.errors.unshift(error);
    if (this.errors.length > 200) {
      this.errors.length = 200;
    }
  }

  allFiles(): FileRecord[] {
    return [...this.files.values()];
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  get(path: string): FileRecord | undefined {
    return this.files.get(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  set(record: FileRecord): void {
    this.files.set(record.path, record);
  }

  remove(path: string): boolean {
    return this.files.delete(path);
  }

  clear(): void {
    this.files.clear();
    this.ignored = [];
    this.errors = [];
    this.stats = emptyStats();
  }

  bumpVersion(at: number): void {
    this.indexVersion += 1;
    this.indexedAt = at;
  }

  findBySymbol(name: string): { file: FileRecord; symbol: FileRecord['symbols'][number] }[] {
    const needle = name.toLowerCase();
    const out: { file: FileRecord; symbol: FileRecord['symbols'][number] }[] = [];
    for (const file of this.files.values()) {
      for (const symbol of file.symbols) {
        if (symbol.name.toLowerCase() === needle) {
          out.push({ file, symbol });
        }
      }
    }
    return out;
  }

  /**
   * Lowercased root segments of the namespaces declared in the workspace.
   *
   * This is what separates an internal namespace that failed to resolve (a real
   * hole in the import graph) from a vendor namespace such as `Psr\` or `Slim\`,
   * which is external by definition and must never be reported as a missing edge.
   */
  declaredNamespaceRoots(): Set<string> {
    const roots = new Set<string>();
    for (const file of this.files.values()) {
      for (const symbol of file.symbols) {
        if (
          symbol.kind !== 'class' &&
          symbol.kind !== 'interface' &&
          symbol.kind !== 'trait' &&
          symbol.kind !== 'enum'
        ) {
          continue;
        }
        const detail = typeof symbol.detail === 'string' ? symbol.detail : '';
        const root = detail.split('\\')[0].trim().toLowerCase();
        if (root.length > 0) {
          roots.add(root);
        }
      }
    }
    return roots;
  }

  /** Files that import `path` directly. */
  reverseDependencies(path: string): FileRecord[] {
    const out: FileRecord[] = [];
    for (const file of this.files.values()) {
      if (file.path === path) {
        continue;
      }
      if (file.dependencies.includes(path)) {
        out.push(file);
      }
    }
    return out;
  }

  /** All parsed references to a symbol name, with the file that contains them. */
  referencesTo(name: string): { path: string; line: number; kind: string; confidence: string }[] {
    const needle = name.toLowerCase();
    const out: { path: string; line: number; kind: string; confidence: string }[] = [];
    for (const file of this.files.values()) {
      for (const reference of file.references) {
        if (typeof reference.name !== 'string') {
          continue;
        }
        if (reference.name.toLowerCase() === needle) {
          out.push({ path: file.path, line: reference.line, kind: reference.kind, confidence: reference.confidence });
        }
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /** Text-level occurrences used as a heuristic fallback (import specifiers, docs). */
  heuristicMentions(name: string, limit = 50): { path: string; line: number }[] {
    const needle = name.toLowerCase();
    const out: { path: string; line: number }[] = [];
    for (const file of this.files.values()) {
      for (const importRecord of file.imports) {
        if (importRecord.specifier.toLowerCase().includes(needle)) {
          out.push({ path: file.path, line: importRecord.line });
          if (out.length >= limit) {
            return out;
          }
        }
      }
    }
    return out;
  }

  filesUnder(dir: string): FileRecord[] {
    return this.allFiles().filter((file) => isInside(dir, file.path));
  }

  /** Directory level aggregation for the project map and overview. */
  modules(): { path: string; files: FileRecord[] }[] {
    const byDir = new Map<string, FileRecord[]>();
    for (const file of this.files.values()) {
      const dir = moduleOf(file.path);
      const list = byDir.get(dir);
      if (list) {
        list.push(file);
      } else {
        byDir.set(dir, [file]);
      }
    }
    return [...byDir.entries()].map(([path, files]) => ({ path, files }));
  }

  dependencies(): { from: string; to: string; confidence: 'exact' | 'heuristic' }[] {
    const edges: { from: string; to: string; confidence: 'exact' | 'heuristic' }[] = [];
    for (const file of this.files.values()) {
      for (const dependency of file.dependencies) {
        edges.push({ from: file.path, to: dependency, confidence: 'heuristic' });
      }
    }
    return edges;
  }

  getParseCacheEntry(key: string): CacheableFileData | undefined {
    return this.parseCache.get(key);
  }

  setParseCacheEntry(key: string, value: CacheableFileData): void {
    this.parseCache.set(key, value);
    if (this.parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
      const oldest = this.parseCache.keys().next();
      if (!oldest.done) {
        this.parseCache.delete(oldest.value);
      }
    }
  }

  parseCacheSize(): number {
    return this.parseCache.size;
  }

  parseCacheEntries(): [string, CacheableFileData][] {
    return [...this.parseCache.entries()];
  }

  clearParseCache(): void {
    this.parseCache.clear();
  }

  toPersisted(contextCache: PersistedIndex['contextCache']): PersistedIndex {
    return {
      schemaVersion: this.schemaVersion,
      parserVersion: this.parserVersion,
      indexVersion: this.indexVersion,
      rootKey: this.rootKey,
      rootName: this.rootName,
      configSignature: this.configSignature,
      indexedAt: this.indexedAt,
      complete: this.complete,
      partial: this.partial,
      files: this.allFiles(),
      ignored: this.ignored,
      errors: this.errors,
      parseCache: Object.fromEntries(this.parseCache),
      contextCache,
      stats: this.getStats()
    };
  }

  static fromPersisted(persisted: PersistedIndex): ProjectIndex {
    const index = new ProjectIndex();
    index.schemaVersion = persisted.schemaVersion;
    index.parserVersion = persisted.parserVersion;
    index.indexVersion = persisted.indexVersion;
    index.rootKey = persisted.rootKey;
    index.rootName = persisted.rootName;
    index.configSignature = persisted.configSignature;
    index.indexedAt = persisted.indexedAt;
    index.complete = persisted.complete;
    index.partial = persisted.partial;
    for (const file of persisted.files) {
      index.set(file);
    }
    index.ignored = persisted.ignored ?? [];
    index.errors = persisted.errors ?? [];
    index.stats = persisted.stats ?? emptyStats();
    for (const [key, value] of Object.entries(persisted.parseCache ?? {})) {
      index.parseCache.set(key, value);
    }
    return index;
  }
}

/** Groups a file path into the top two directory levels, so the map stays readable. */
export function moduleOf(path: string): string {
  const dir = dirOf(path);
  if (dir === '') {
    return '(root)';
  }
  const parts = dir.split('/');
  if (parts.length === 1) {
    return parts[0];
  }
  return parts.slice(0, 2).join('/');
}

export function emptyStats(): IndexStats {
  return {
    indexedFiles: 0,
    updatedFiles: 0,
    removedFiles: 0,
    unchangedFiles: 0,
    parseErrors: 0,
    ignoredFiles: 0,
    lastDurationMs: 0
  };
}
