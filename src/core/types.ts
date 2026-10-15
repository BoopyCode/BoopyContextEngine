/**
 * Shared data model of the Boopy Context Engine index.
 *
 * These types are intentionally free of any `vscode` dependency so that the whole
 * analysis pipeline can be unit tested without an Extension Host.
 */

/** How trustworthy a piece of information is. Never claim more than we have. */
export type Confidence = 'exact' | 'heuristic';

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'php'
  | 'python'
  | 'sql'
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'html'
  | 'css'
  | 'shell'
  | 'dockerfile'
  | 'other';

export type FileKind =
  | 'source'
  | 'test'
  | 'config'
  | 'doc'
  | 'migration'
  | 'schema'
  | 'style'
  | 'template'
  | 'other';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'trait'
  | 'enum'
  | 'type'
  | 'namespace'
  | 'function'
  | 'method'
  | 'const'
  | 'variable'
  | 'component'
  | 'table'
  | 'column'
  | 'view'
  | 'index'
  | 'route'
  | 'section';

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  /** 1-based last line of the declaration body, when known. */
  endLine?: number;
  exported?: boolean;
  /** Enclosing symbol for methods and nested declarations. */
  container?: string;
  /** Declaration line, trimmed and length capped. */
  signature?: string;
  /** First line of the doc comment directly above the declaration. */
  doc?: string;
  confidence: Confidence;
  /** Extra structured information, e.g. column type or HTTP method for routes. */
  detail?: string;
}

export interface ImportRecord {
  specifier: string;
  line: number;
  /** Resolved workspace-relative path when the specifier points inside the workspace. */
  resolved?: string;
  confidence: Confidence;
}

export type ReferenceKind = 'call' | 'type' | 'new' | 'member';

export interface ReferenceRecord {
  name: string;
  line: number;
  kind: ReferenceKind;
  confidence: Confidence;
}

export interface SymbolReference extends ReferenceRecord {
  /** Workspace-relative path of the referencing file. */
  path: string;
}

/** Everything the index knows about a single indexed file. */
export interface FileRecord {
  /** Workspace-relative POSIX path. */
  path: string;
  /** sha1 of the file content, used for incremental updates. */
  hash: string;
  size: number;
  mtimeMs: number;
  language: LanguageId;
  kind: FileKind;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  references: ReferenceRecord[];
  /** Workspace-relative paths this file imports. */
  dependencies: string[];
  /** Workspace-relative test files bound to this file by convention or usage. */
  tests?: string[];
  /** For test files: the workspace-relative path of the tested source, when inferred. */
  testedPath?: string;
  /** Overall parser confidence for this file. */
  confidence: Confidence;
  indexedAt: number;
  /** Set when the last parse attempt failed; the previous record was kept. */
  parseError?: string;
  /** Structured facts extracted by the parser (dependency lists, service names, namespaces, ...). */
  facts?: Record<string, unknown>;
}

export interface DetectionResult {
  name: string;
  confidence: Confidence;
  evidence: string;
}

export interface ProjectModule {
  /** Workspace-relative directory. */
  path: string;
  fileCount: number;
  languages: LanguageId[];
  topSymbols: string[];
  /** Number of indexed files in other modules importing this module. */
  dependents: number;
}

export interface ProjectOverview {
  schemaVersion: number;
  indexVersion: number;
  rootName: string;
  indexedAt: number;
  complete: boolean;
  /** True when some files could not be parsed or were skipped because of limits. */
  partial: boolean;
  fileCount: number;
  ignoredCount: number;
  languages: Partial<Record<LanguageId, number>>;
  frameworks: DetectionResult[];
  entryPoints: string[];
  configFiles: string[];
  projectInstructions: string[];
  databaseObjects: { name: string; kind: SymbolKind; path: string; line: number }[];
  apiRoutes: { name: string; detail?: string; path: string; line: number; confidence: Confidence }[];
  modules: ProjectModule[];
  tests: { path: string; testedPath?: string }[];
  testConfigFiles: string[];
  errors: IndexError[];
}

export interface IndexError {
  path: string;
  message: string;
  at: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  confidence: Confidence;
}

export interface DependencyGraph {
  schemaVersion: number;
  indexVersion: number;
  updatedAt: number;
  edges: DependencyEdge[];
  /** Import specifiers that could not be resolved inside the workspace. */
  externalImports: string[];
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface DatabaseColumn {
  name: string;
  type?: string;
  constraints?: string;
}

export interface DatabaseSchemaEntry {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  columns: DatabaseColumn[];
  references: string[];
  confidence: Confidence;
}

export interface DatabaseSchema {
  schemaVersion: number;
  indexVersion: number;
  updatedAt: number;
  tables: DatabaseSchemaEntry[];
  migrations: string[];
}

export interface ProjectMap {
  schemaVersion: number;
  indexVersion: number;
  updatedAt: number;
  rootName: string;
  complete: boolean;
  partial: boolean;
  overview: ProjectOverview;
  dependencies: DependencyGraph;
  databaseSchema: DatabaseSchema;
  entryPoints: string[];
}

/** Persisted index payload written to disk. */
export interface PersistedIndex {
  schemaVersion: number;
  parserVersion: string;
  indexVersion: number;
  rootKey: string;
  rootName: string;
  configSignature: string;
  indexedAt: number;
  complete: boolean;
  partial: boolean;
  files: FileRecord[];
  ignored: IgnoredFile[];
  errors: IndexError[];
  /** Layer 1 computation cache: `${parserVersion}:${hash}` -> parsed file data. */
  parseCache: Record<string, CacheableFileData>;
  /** Layer 2 context cache. */
  contextCache: Record<string, PersistedContextCacheEntry>;
  stats: IndexStats;
}

export interface CacheableFileData {
  language: LanguageId;
  kind: FileKind;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  references: ReferenceRecord[];
  dependencies: string[];
  confidence: Confidence;
  facts?: Record<string, unknown>;
}

export interface PersistedContextCacheEntry {
  createdAt: number;
  /** File path -> content hash of the data this entry was computed from. */
  deps: Record<string, string>;
  payload: unknown;
}

export interface IndexStats {
  indexedFiles: number;
  updatedFiles: number;
  removedFiles: number;
  unchangedFiles: number;
  parseErrors: number;
  ignoredFiles: number;
  lastDurationMs: number;
}

export interface IgnoredFile {
  path: string;
  reason: string;
  source: string;
}

export interface IndexFreshness {
  complete: boolean;
  partial: boolean;
  stale: boolean;
  paused: boolean;
  indexing: boolean;
  indexVersion: number;
  indexedAt: number;
  /** Milliseconds since the index was last fully updated. */
  ageMs: number;
  pendingPaths: string[];
  errors: IndexError[];
}

export type IndexPhase = 'idle' | 'scanning' | 'indexing' | 'paused' | 'error';

export interface IndexProgress {
  phase: IndexPhase;
  processed: number;
  total: number;
  currentPath?: string;
}
