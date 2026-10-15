import * as vscode from 'vscode';
import { WorkspaceConfig, configSignature, maxFileSizeBytes } from '../core/config';
import { BceLogger, BceStatusBar, readWorkspaceConfig } from './ui';
import { NodeFileSystem } from '../core/io/nodeFs';
import { NodeStoreFs } from '../core/io/storeFs';
import { IndexStore } from '../core/index/indexStore';
import { IgnoreEngine } from '../core/ignore/ignoreEngine';
import { ParserRegistry } from '../core/parse/registry';
import { Metrics } from '../core/diagnostics/metrics';
import { UsageLedger } from '../core/diagnostics/usageLedger';
import { ContextCache } from '../core/cache/contextCache';
import { GitClient } from '../core/vcs/git';
import { ProjectIndexer } from '../core/index/projectIndexer';
import { WorkspaceIntelligence } from '../core/workspace';
import { ChildProcessRunner } from './gitRunner';
import { VsCodeDocumentProvider } from './documents';
import { sha1 } from '../core/util/hash';
import { normalizeRel, toPosix } from '../core/util/paths';
import { ensureBceGitIgnored } from './gitignore';

export class WorkspaceSession implements vscode.Disposable {
  readonly rootKey: string;
  readonly rootName: string;
  readonly folder: vscode.WorkspaceFolder;
  readonly fs: NodeFileSystem;
  readonly store: IndexStore;
  readonly metrics: Metrics;
  readonly usage: UsageLedger;
  readonly contextCache: ContextCache<unknown>;
  readonly indexer: ProjectIndexer;
  readonly intelligence: WorkspaceIntelligence;

  private config: WorkspaceConfig;
  private ignoreEngine: IgnoreEngine;
  private readonly parsers = new ParserRegistry();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private git?: GitClient;
  private storageUri: vscode.Uri;
  private storageInsideProject = false;
  private disposed = false;
  private gitIgnoreOutcome = 'not checked';

  private constructor(
    folder: vscode.WorkspaceFolder,
    config: WorkspaceConfig,
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly logger: BceLogger,
    private readonly statusBar: BceStatusBar,
    storageUri: vscode.Uri,
    storageInsideProject: boolean,
    usage: UsageLedger
  ) {
    this.folder = folder;
    this.config = config;
    this.storageUri = storageUri;
    this.storageInsideProject = storageInsideProject;
    this.rootKey = sha1(toPosix(folder.uri.fsPath).toLowerCase());
    this.rootName = folder.name;
    this.fs = new NodeFileSystem(folder.uri.fsPath);
    this.store = new IndexStore(new NodeStoreFs(storageUri.fsPath));
    this.metrics = new Metrics();
    this.usage = usage;
    this.contextCache = new ContextCache<unknown>();
    this.ignoreEngine = this.createIgnoreEngine();
    this.git = new GitClient(new ChildProcessRunner(), folder.uri.fsPath);

    this.indexer = new ProjectIndexer({
      fs: this.fs,
      store: this.store,
      parsers: this.parsers,
      createIgnoreEngine: () => this.ignoreEngine,
      scanOptions: () => ({
        maxFileSizeBytes: maxFileSizeBytes(this.config),
        maxFiles: this.config.maxFiles,
        followSymlinks: this.config.followSymlinks
      }),
      metrics: this.metrics,
      contextCache: this.contextCache,
      rootKey: this.rootKey,
      rootName: this.rootName,
      configSignature: () => configSignature(this.config),
      log: (level, message) => this.logger.log(level, `[${this.rootName}] ${message}`)
    });

    this.intelligence = new WorkspaceIntelligence({
      rootName: this.rootName,
      rootDisplayPath: folder.uri.fsPath,
      fs: this.fs,
      ignore: this.ignoreEngine,
      indexer: this.indexer,
      metrics: this.metrics,
      contextCache: this.contextCache,
      config: this.config,
      git: this.git,
      documents: new VsCodeDocumentProvider(folder),
      parsers: this.parsers,
      usage: this.usage
    });

    this.disposables.push(
      this.indexer.onStateChange((state) => {
        this.statusBar.update(state, {
          enabled: this.config.enabled,
          files: this.indexer.getIndex().size,
          ignored: this.indexer.getIndex().getIgnored().length
        });
      })
    );
  }

  static async create(
    folder: vscode.WorkspaceFolder,
    extensionContext: vscode.ExtensionContext,
    logger: BceLogger,
    statusBar: BceStatusBar
  ): Promise<WorkspaceSession> {
    const config = readWorkspaceConfig(folder);
    const { uri, insideProject } = await resolveStorageUri(folder, extensionContext, config);
    const usage = await UsageLedger.load({
      store: new NodeStoreFs(uri.fsPath),
      rootName: folder.name,
      enabled: () => readWorkspaceConfig(folder).usageLog,
      log: (level, message) => logger.log(level, `[${folder.name}] ${message}`)
    });
    const session = new WorkspaceSession(folder, config, extensionContext, logger, statusBar, uri, insideProject, usage);
    return session;
  }

  getConfig(): WorkspaceConfig {
    return this.config;
  }

  getGitIgnoreOutcome(): string {
    return this.gitIgnoreOutcome;
  }

  getStorageUri(): vscode.Uri {
    return this.storageUri;
  }

  /** Creates the storage directory, keeps BCE out of git, starts indexing and watching. */
  async start(): Promise<void> {
    this.logger.setLevel(this.config.diagnosticsLevel);
    await vscode.workspace.fs.createDirectory(this.storageUri).then(
      () => undefined,
      (error) => this.logger.log('warn', `Could not create the BCE storage directory: ${error}`)
    );
    this.statusBar.update(this.indexer.getState(), {
      enabled: this.config.enabled,
      files: this.indexer.getIndex().size,
      ignored: this.indexer.getIndex().getIgnored().length
    });
    if (!this.config.enabled) {
      this.logger.log('info', `BCE is disabled for ${this.rootName}.`);
      return;
    }
    this.gitIgnoreOutcome = await this.applyGitIgnore();
    if (this.config.autoIndex) {
      this.watch();
      void this.indexer.initialize();
    } else {
      await this.indexer.initialize({ loadOnly: true });
      this.logger.log('info', 'Automatic indexing is disabled (bce.autoIndex). Use "BCE: Analyze Project" or "BCE: Rebuild Index" to index on demand.');
    }
  }

  /** Re-reads settings. Returns true when the indexing relevant settings changed. */
  async updateConfig(): Promise<{ signatureChanged: boolean; enabledChanged: boolean }> {
    if (this.disposed) {
      return { signatureChanged: false, enabledChanged: false };
    }
    const previous = this.config;
    const next = readWorkspaceConfig(this.folder);
    const signatureChanged = configSignature(previous) !== configSignature(next);
    const storageChanged = previous.storageLocation !== next.storageLocation;
    this.config = next;
    this.logger.setLevel(next.diagnosticsLevel);
    this.ignoreEngine = this.createIgnoreEngine();

    if (storageChanged) {
      const { uri, insideProject } = await resolveStorageUri(this.folder, this.extensionContext, next);
      this.storageUri = uri;
      this.storageInsideProject = insideProject;
      this.logger.log('info', 'Storage location changed; a rebuild is required to use the new location.');
    }
    this.gitIgnoreOutcome = await this.applyGitIgnore();

    if (!next.enabled) {
      this.watcher?.dispose();
      this.watcher = undefined;
    } else if (next.autoIndex && !this.watcher) {
      this.watch();
    }
    return { signatureChanged, enabledChanged: previous.enabled !== next.enabled };
  }

  isDisabled(): boolean {
    return !this.config.enabled;
  }

  /** True when the given URI belongs to this workspace folder and is not BCE's own storage. */
  ownsUri(uri?: vscode.Uri): boolean {
    if (!uri || uri.scheme !== 'file') {
      return false;
    }
    const root = toPosix(this.folder.uri.fsPath).replace(/\/+$/, '').toLowerCase();
    const candidate = toPosix(uri.fsPath).toLowerCase();
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      return false;
    }
    return !this.isStoragePath(candidate);
  }

  isInsideFolder(uri?: vscode.Uri): boolean {
    if (!uri || uri.scheme !== 'file') {
      return false;
    }
    const root = toPosix(this.folder.uri.fsPath).replace(/\/+$/, '').toLowerCase();
    const candidate = toPosix(uri.fsPath).toLowerCase();
    return candidate === root || candidate.startsWith(`${root}/`);
  }

  private isStoragePath(absoluteLower: string): boolean {
    const storage = toPosix(this.storageUri.fsPath).replace(/\/+$/, '').toLowerCase();
    return absoluteLower === storage || absoluteLower.startsWith(`${storage}/`);
  }

  async analyzeNow(): Promise<void> {
    await this.indexer.rebuild();
  }

  statusSummary(): string {
    const index = this.indexer.getIndex();
    const freshness = this.indexer.getFreshness();
    return [
      `### ${this.rootName}`,
      `- root: ${this.folder.uri.fsPath}`,
      `- storage: ${this.storageUri.fsPath}${this.storageInsideProject ? ' (inside the project, git-ignored)' : ' (extension storage, project untouched)'}`,
      `- .gitignore: ${this.gitIgnoreOutcome}`,
      `- enabled: ${this.config.enabled}, auto index: ${this.config.autoIndex}, follow symlinks: ${this.config.followSymlinks}`,
      `- respect .gitignore: ${this.config.respectGitignore}, include paths: ${this.config.includePaths.length}, ignore paths: ${this.config.ignorePaths.length}`,
      `- unsaved editor buffers: ${this.intelligence.dirtyDocuments().length}`,
      `- token budget: ${this.config.tokenBudget}, max file size: ${this.config.maxFileSizeKb} KB, max files: ${this.config.maxFiles}`,
      `- index: v${freshness.indexVersion}, ${index.size} file(s), ${index.getIgnored().length} ignored, complete: ${freshness.complete}, stale: ${freshness.stale}, partial: ${freshness.partial}`,
      `- last update: ${freshness.indexedAt === 0 ? 'never' : new Date(freshness.indexedAt).toISOString()}`
    ].join('\n');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.watcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.indexer.dispose();
  }

  private createIgnoreEngine(): IgnoreEngine {
    return new IgnoreEngine({
      includePatterns: this.config.includePaths,
      ignorePatterns: this.config.ignorePaths,
      respectGitignore: this.config.respectGitignore
    });
  }

  private async applyGitIgnore(): Promise<string> {
    if (!this.config.autoGitIgnore) {
      return 'disabled by bce.autoGitIgnore';
    }
    if (!vscode.workspace.isTrusted) {
      return 'skipped (untrusted workspace)';
    }
    try {
      const outcome = await ensureBceGitIgnored(this.folder.uri, {
        trusted: true,
        enabled: true,
        writesIntoProject: this.storageInsideProject
      });
      if (outcome === 'created' || outcome === 'updated') {
        this.logger.log('info', 'Updated .gitignore so BCE output stays out of version control.');
      }
      return outcome;
    } catch (error) {
      this.logger.log('warn', `Could not update .gitignore: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  private watch(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    const handle = (kind: 'change' | 'create' | 'delete') => (uri: vscode.Uri) => {
      if (this.disposed || !this.config.autoIndex) {
        return;
      }
      const relPath = this.toRelative(uri);
      if (!relPath || this.isIgnoredForEvents(relPath)) {
        return;
      }
      this.indexer.handleFileEvent(kind, relPath);
    };
    this.disposables.push(
      this.watcher.onDidChange(handle('change')),
      this.watcher.onDidCreate(handle('create')),
      this.watcher.onDidDelete(handle('delete')),
      this.watcher
    );
    this.logger.log('debug', 'File watcher started.');
  }

  private toRelative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const absolute = toPosix(uri.fsPath);
    if (this.isStoragePath(absolute.toLowerCase())) {
      return undefined;
    }
    const root = toPosix(this.folder.uri.fsPath).replace(/\/+$/, '');
    if (!absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return undefined;
    }
    const relPath = normalizeRel(absolute.slice(root.length + 1));
    return relPath.length > 0 ? relPath : undefined;
  }

  private isIgnoredForEvents(relPath: string): boolean {
    const decision = this.ignoreEngine.check(relPath);
    return decision.ignored;
  }
}

/** Resolves where the index/map/cache for a workspace folder live. */
export async function resolveStorageUri(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  config: WorkspaceConfig
): Promise<{ uri: vscode.Uri; insideProject: boolean }> {
  if (config.storageLocation === 'workspace') {
    return { uri: vscode.Uri.joinPath(folder.uri, '.bce'), insideProject: true };
  }
  const base = context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, 'workspaces', sha1(toPosix(folder.uri.fsPath).toLowerCase()));
  return { uri: vscode.Uri.joinPath(base, 'bce-index'), insideProject: false };
}

export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, WorkspaceSession>();
  private readonly emitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly logger: BceLogger,
    private readonly statusBar: BceStatusBar
  ) {}

  /** Fires when the set of sessions or their indexing state changes. */
  get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  async refreshFolders(): Promise<WorkspaceSession[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = new Set(folders.map((folder) => folder.uri.toString()));
    for (const [key, session] of [...this.sessions]) {
      if (!active.has(key)) {
        session.dispose();
        this.sessions.delete(key);
        this.logger.log('info', `Workspace folder closed: ${session.rootName}`);
      }
    }
    const created: WorkspaceSession[] = [];
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (!this.sessions.has(key)) {
        const session = await WorkspaceSession.create(folder, this.extensionContext, this.logger, this.statusBar);
        this.sessions.set(key, session);
        created.push(session);
        await session.start();
        this.logger.log('info', `Workspace folder ready: ${folder.uri.fsPath}`);
      }
    }
    this.emitter.fire();
    return created;
  }

  all(): WorkspaceSession[] {
    return [...this.sessions.values()];
  }

  getForUri(uri?: vscode.Uri): WorkspaceSession | undefined {
    if (uri) {
      for (const session of this.sessions.values()) {
        if (session.ownsUri(uri)) {
          return session;
        }
      }
      for (const session of this.sessions.values()) {
        if (session.isInsideFolder(uri)) {
          return session;
        }
      }
    }
    return this.default();
  }

  default(): WorkspaceSession | undefined {
    const active = this.sessions.get(vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '');
    if (active && !active.isDisabled()) {
      return active;
    }
    return this.all().find((session) => !session.isDisabled()) ?? this.all()[0];
  }

  /** Sessions that will actually answer tool calls. */
  enabled(): WorkspaceSession[] {
    return this.all().filter((session) => !session.isDisabled());
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.emitter.dispose();
  }
}
