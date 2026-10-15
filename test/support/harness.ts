import { NodeFileSystem } from '../../src/core/io/nodeFs';
import { NodeStoreFs } from '../../src/core/io/storeFs';
import { IndexStore } from '../../src/core/index/indexStore';
import { ProjectIndexer as Indexer, IndexerDeps } from '../../src/core/index/projectIndexer';
import { IgnoreEngine } from '../../src/core/ignore/ignoreEngine';
import { ParserRegistry } from '../../src/core/parse/registry';
import { Metrics } from '../../src/core/diagnostics/metrics';
import { UsageLedger } from '../../src/core/diagnostics/usageLedger';
import { ContextCache } from '../../src/core/cache/contextCache';
import { WorkspaceIntelligence } from '../../src/core/workspace';
import { defaultWorkspaceConfig, WorkspaceConfig, configSignature, maxFileSizeBytes } from '../../src/core/config';
import { GitClient } from '../../src/core/vcs/git';
import { ScanOptions } from '../../src/core/scan/scanner';
import { createTempDir, createTempProject } from './tempProject';
import { sha1 } from '../../src/core/util/hash';
import { toPosix } from '../../src/core/util/paths';
import { MemoryStoreFs } from './memoryFs';
import { StoreFs } from '../../src/core/io/storeFs';
import { DocumentSnapshot, OpenDocumentProvider } from '../../src/core/io/documents';

export interface HarnessOptions {
  /** Reuse an existing directory instead of copying the fixture. */
  root?: string;
  config?: Partial<WorkspaceConfig>;
  /** Use the in-memory store instead of the real one (useful to inspect writes). */
  memoryStore?: boolean;
  store?: StoreFs;
  /** Inject a command runner so git behavior can be simulated. */
  gitRunner?: { run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> };
  parsers?: ParserRegistry;
  /** Editor state provider; defaults to "no open documents". */
  documents?: OpenDocumentProvider;
  concurrency?: number;
}

export interface Harness {
  root: string;
  cleanup(): Promise<void>;
  fs: NodeFileSystem;
  store: IndexStore;
  memoryStore?: MemoryStoreFs;
  indexer: Indexer;
  intelligence: WorkspaceIntelligence;
  metrics: Metrics;
  contextCache: ContextCache<unknown>;
  config: WorkspaceConfig;
  logs: string[];
  usage: UsageLedger;
  work(): Promise<void>;
  reloadIgnore(): void;
}

const SILENT = (): void => undefined;

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = options.root ? { dir: options.root, cleanup: async () => undefined } : await createTempProject();
  const storage = await createTempDir('bce-storage');
  const config: WorkspaceConfig = {
    ...defaultWorkspaceConfig,
    tokenBudget: 2000,
    snippetLines: 8,
    ...options.config
  };
  const fs = new NodeFileSystem(temp.dir);
  const memoryStore = options.memoryStore ? new MemoryStoreFs() : undefined;
  const store = new IndexStore(options.store ?? memoryStore ?? new NodeStoreFs(storage.dir));
  const metrics = new Metrics();
  const contextCache = new ContextCache<unknown>();
  const logs: string[] = [];
  let ignoreEngine = createIgnore(config);

  const parsers = options.parsers ?? new ParserRegistry();
  const deps: IndexerDeps = {
    fs,
    store,
    parsers,
    createIgnoreEngine: () => ignoreEngine,
    scanOptions: (): ScanOptions => ({
      maxFileSizeBytes: maxFileSizeBytes(config),
      maxFiles: config.maxFiles,
      followSymlinks: config.followSymlinks
    }),
    metrics,
    contextCache,
    rootKey: sha1(toPosix(temp.dir).toLowerCase()),
    rootName: 'fixture',
    configSignature: () => configSignature(config),
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
      logs.push(`${level}: ${message}`);
    },
    concurrency: options.concurrency ?? 4
  };

  const indexer = new Indexer(deps);
  const git = options.gitRunner ? new GitClient(options.gitRunner, temp.dir) : undefined;
  const usageStore = options.store ?? memoryStore ?? new NodeStoreFs(storage.dir);
  const usage = await UsageLedger.load({
    store: usageStore,
    rootName: 'fixture',
    enabled: () => config.usageLog,
    log: (level: 'debug' | 'info' | 'warn', message: string) => {
      logs.push(`${level}: ${message}`);
    }
  });
  const intelligence = new WorkspaceIntelligence({
    rootName: 'fixture',
    rootDisplayPath: temp.dir,
    fs,
    ignore: ignoreEngine,
    indexer,
    metrics,
    contextCache,
    config,
    git,
    documents: options.documents,
    parsers,
    usage
  });

  return {
    root: temp.dir,
    cleanup: async (): Promise<void> => {
      indexer.dispose();
      await temp.cleanup();
      await storage.cleanup();
    },
    fs,
    store,
    memoryStore,
    indexer,
    intelligence,
    metrics,
    contextCache,
    config,
    logs,
    usage,
    work: async (): Promise<void> => {
      await indexer.initialize({ fullScan: true });
      // Generous: the suite also runs on busy machines where a scan of the fixture can
      // take far longer than its normal few hundred milliseconds.
      await indexer.waitForIdle(120_000);
    },
    reloadIgnore(): void {
      ignoreEngine = createIgnore(config);
    }
  };
}

export function createIgnore(config: WorkspaceConfig): IgnoreEngine {
  return new IgnoreEngine({
    includePatterns: config.includePaths,
    ignorePatterns: config.ignorePaths,
    respectGitignore: config.respectGitignore
  });
}

export const silentLogger = SILENT;

/** Mutable editor state for tests: `set` marks a path as an unsaved open buffer. */
export class FakeDocuments implements OpenDocumentProvider {
  private readonly open = new Map<string, DocumentSnapshot>();

  set(relPath: string, text: string, version = 1): void {
    this.open.set(relPath, { relPath, text, version, dirty: true });
  }

  save(relPath: string): void {
    this.open.delete(relPath);
  }

  get(relPath: string): DocumentSnapshot | undefined {
    return this.open.get(relPath);
  }

  dirtyDocuments(): DocumentSnapshot[] {
    return [...this.open.values()];
  }
}
