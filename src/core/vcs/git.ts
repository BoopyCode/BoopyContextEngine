/**
 * Version of git related signals. Implemented with an injected command runner so
 * the behavior is testable without a real repository and so a missing git binary
 * degrades gracefully (the feature is simply unavailable).
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export interface RecentChanges {
  available: boolean;
  reason?: string;
  branch?: string;
  /** Workspace-relative POSIX paths, most recently changed first. */
  changedPaths: string[];
}

export class GitClient {
  private availability?: { available: boolean; reason?: string };

  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string
  ) {}

  async isRepository(): Promise<{ available: boolean; reason?: string }> {
    if (this.availability) {
      return this.availability;
    }
    try {
      const result = await this.runner.run('git', ['rev-parse', '--is-inside-work-tree'], this.cwd);
      if (result.code !== 0 || !result.stdout.trim().startsWith('true')) {
        this.availability = { available: false, reason: 'not a git working tree' };
      } else {
        this.availability = { available: true };
      }
    } catch (error) {
      this.availability = { available: false, reason: error instanceof Error ? error.message : 'git is not available' };
    }
    return this.availability;
  }

  async recentChanges(sinceDays: number, fileLimit = 300): Promise<RecentChanges> {
    const repository = await this.isRepository();
    if (!repository.available) {
      return { available: false, reason: repository.reason, changedPaths: [] };
    }
    const args = ['log', `--since=${sinceDays} days ago`, '--name-only', '--pretty=format:__commit__%H', `-n`, '200'];
    const result = await this.runner.run('git', args, this.cwd);
    if (result.code !== 0) {
      return { available: false, reason: result.stderr.trim() || 'git log failed', changedPaths: [] };
    }
    const seen = new Set<string>();
    const changedPaths: string[] = [];
    for (const rawLine of result.stdout.split('\n')) {
      const line = rawLine.trim().replace(/\\/g, '/');
      if (line.length === 0 || line.startsWith('__commit__')) {
        continue;
      }
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      changedPaths.push(line);
      if (changedPaths.length >= fileLimit) {
        break;
      }
    }
    const branchResult = await this.runner.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd);
    return {
      available: true,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : undefined,
      changedPaths
    };
  }
}
