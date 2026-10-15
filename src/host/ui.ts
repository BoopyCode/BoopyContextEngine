import * as vscode from 'vscode';
import { defaultWorkspaceConfig, WorkspaceConfig } from '../core/config';
import { IndexerState } from '../core/index/projectIndexer';

export function readWorkspaceConfig(folder?: vscode.WorkspaceFolder): WorkspaceConfig {
  const cfg = vscode.workspace.getConfiguration('bce', folder?.uri);
  return {
    enabled: cfg.get<boolean>('enabled', defaultWorkspaceConfig.enabled),
    autoIndex: cfg.get<boolean>('autoIndex', defaultWorkspaceConfig.autoIndex),
    tokenBudget: cfg.get<number>('tokenBudget', defaultWorkspaceConfig.tokenBudget),
    maxFileSizeKb: cfg.get<number>('maxFileSizeKb', defaultWorkspaceConfig.maxFileSizeKb),
    maxFiles: cfg.get<number>('maxFiles', defaultWorkspaceConfig.maxFiles),
    respectGitignore: cfg.get<boolean>('respectGitignore', defaultWorkspaceConfig.respectGitignore),
    includePaths: cfg.get<string[]>('includePaths', defaultWorkspaceConfig.includePaths),
    ignorePaths: cfg.get<string[]>('ignorePaths', defaultWorkspaceConfig.ignorePaths),
    followSymlinks: cfg.get<boolean>('followSymlinks', defaultWorkspaceConfig.followSymlinks),
    autoGitIgnore: cfg.get<boolean>('autoGitIgnore', defaultWorkspaceConfig.autoGitIgnore),
    storageLocation: cfg.get<'extensionStorage' | 'workspace'>('storage.location', defaultWorkspaceConfig.storageLocation),
    diagnosticsLevel: cfg.get<'off' | 'normal' | 'verbose'>('diagnostics.level', defaultWorkspaceConfig.diagnosticsLevel),
    maxSearchResults: cfg.get<number>('search.maxResults', defaultWorkspaceConfig.maxSearchResults),
    snippetLines: cfg.get<number>('search.snippetLines', defaultWorkspaceConfig.snippetLines),
    recencyDays: cfg.get<number>('git.recencyDays', defaultWorkspaceConfig.recencyDays),
    tools: {
      projectOverview: cfg.get<boolean>('tools.projectOverview.enabled', true),
      findContext: cfg.get<boolean>('tools.findContext.enabled', true),
      fileContext: cfg.get<boolean>('tools.fileContext.enabled', true),
      explainImpact: cfg.get<boolean>('tools.explainImpact.enabled', true),
      relatedTests: cfg.get<boolean>('tools.relatedTests.enabled', true),
      status: cfg.get<boolean>('tools.status.enabled', true)
    }
  };
}

export class BceLogger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private level: 'off' | 'normal' | 'verbose' = 'normal';

  constructor(private readonly prefix = 'bce') {
    this.channel = vscode.window.createOutputChannel('Boopy Context Engine');
  }

  setLevel(level: 'off' | 'normal' | 'verbose'): void {
    this.level = level;
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.level === 'off' && level !== 'error') {
      return;
    }
    if (level === 'debug' && this.level !== 'verbose') {
      return;
    }
    const stamp = new Date().toISOString().slice(11, 19);
    this.channel.appendLine(`[${stamp}] [${this.prefix}] [${level}] ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

export class BceStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('bce.status', vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'bce.showDiagnostics';
    this.item.name = 'Boopy Context Engine';
    this.item.text = '$(database) bce: starting';
    this.item.tooltip = 'Boopy Context Engine';
    this.item.show();
  }

  update(state: IndexerState, extra: { enabled: boolean; files: number; ignored: number }): void {
    if (!extra.enabled) {
      this.item.text = '$(circle-slash) bce: off';
      this.item.tooltip = 'Boopy Context Engine is disabled (bce.enabled).';
      this.item.backgroundColor = undefined;
      return;
    }
    const { phase, progress, freshness } = state;
    if (phase === 'scanning') {
      this.item.text = `$(sync~spin) bce: scanning${progress.currentPath ? ` ${progress.currentPath}` : ''}`;
      this.item.backgroundColor = undefined;
    } else if (phase === 'indexing') {
      const total = progress.total > 0 ? ` ${progress.processed}/${progress.total}` : '';
      this.item.text = `$(sync~spin) bce: Indexing${total}`;
      this.item.backgroundColor = undefined;
    } else if (freshness.paused) {
      this.item.text = '$(debug-pause) bce: paused';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (phase === 'error' || freshness.partial) {
      this.item.text = `$(warning) bce: warning (${extra.files} files)`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (freshness.stale) {
      this.item.text = `$(refresh) bce: updating (${extra.files} files)`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(database) bce: Ready (${extra.files} files)`;
      this.item.backgroundColor = undefined;
    }
    const pending = freshness.pendingPaths.length;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Boopy Context Engine**\n\n`);
    tooltip.appendMarkdown(`- index version: ${freshness.indexVersion}\n`);
    tooltip.appendMarkdown(`- indexed files: ${extra.files} (${extra.ignored} ignored)\n`);
    tooltip.appendMarkdown(`- last update: ${freshness.indexedAt === 0 ? 'never' : new Date(freshness.indexedAt).toLocaleString()}\n`);
    tooltip.appendMarkdown(`- state: ${freshness.complete ? (freshness.stale ? 'stale' : 'fresh') : 'incomplete'}${freshness.partial ? ', partial' : ''}\n`);
    if (pending > 0) {
      tooltip.appendMarkdown(`- pending updates: ${pending}\n`);
    }
    if (freshness.errors.length > 0) {
      tooltip.appendMarkdown(`- errors: ${freshness.errors.length}\n`);
    }
    tooltip.appendMarkdown(`\nClick for diagnostics.`);
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
