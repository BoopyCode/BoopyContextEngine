import { sha1 } from './util/hash';

/** Workspace scoped configuration, resolved from the `bce.*` settings. */
export interface WorkspaceConfig {
  enabled: boolean;
  /**
   * Adds a hard rule to the chat instructions. VS Code gives an extension no
   * hook before another tool runs, so this cannot block a grep - it strengthens
   * the prompt and says so, instead of pretending to be a gate.
   */
  enforceContextFirst: boolean;
  autoIndex: boolean;
  tokenBudget: number;
  maxFileSizeKb: number;
  maxFiles: number;
  respectGitignore: boolean;
  includePaths: string[];
  ignorePaths: string[];
  followSymlinks: boolean;
  autoGitIgnore: boolean;
  storageLocation: 'extensionStorage' | 'workspace';
  diagnosticsLevel: 'off' | 'normal' | 'verbose';
  maxSearchResults: number;
  snippetLines: number;
  recencyDays: number;
  /** Keeps an append only log of tool calls plus the estimated naive baseline. */
  usageLog: boolean;
  tools: {
    projectOverview: boolean;
    findContext: boolean;
    fileContext: boolean;
    explainImpact: boolean;
    relatedTests: boolean;
    status: boolean;
  };
}

export const defaultWorkspaceConfig: WorkspaceConfig = {
  enabled: true,
  enforceContextFirst: false,
  autoIndex: true,
  tokenBudget: 4000,
  maxFileSizeKb: 512,
  maxFiles: 20000,
  respectGitignore: true,
  includePaths: [],
  ignorePaths: [],
  followSymlinks: false,
  autoGitIgnore: true,
  storageLocation: 'extensionStorage',
  diagnosticsLevel: 'normal',
  maxSearchResults: 12,
  snippetLines: 12,
  recencyDays: 14,
  usageLog: true,
  tools: {
    projectOverview: true,
    findContext: true,
    fileContext: true,
    explainImpact: true,
    relatedTests: true,
    status: true
  }
};

/**
 * Signature of everything that changes what the index should contain. When it
 * changes, the stored index is re-checked and, if needed, rebuilt from scratch.
 */
export function configSignature(config: WorkspaceConfig): string {
  return sha1(
    JSON.stringify({
      respectGitignore: config.respectGitignore,
      includePaths: [...config.includePaths].sort(),
      ignorePaths: [...config.ignorePaths].sort(),
      followSymlinks: config.followSymlinks,
      maxFileSizeKb: config.maxFileSizeKb,
      maxFiles: config.maxFiles
    })
  ).slice(0, 16);
}

export function maxFileSizeBytes(config: WorkspaceConfig): number {
  return Math.max(4 * 1024, Math.round(config.maxFileSizeKb * 1024));
}

export function clampTokenBudget(requested: number | undefined, fallback: number): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.round(requested) : fallback;
  return Math.min(Math.max(value, 200), 20000);
}
