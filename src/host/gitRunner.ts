import { execFile } from 'node:child_process';
import { CommandResult, CommandRunner } from '../core/vcs/git';

/**
 * Runs git through child_process with a hard timeout. Git is optional: when the
 * binary is missing or the folder is not a repository, callers degrade to
 * "recent changes unavailable" instead of failing.
 */
export class ChildProcessRunner implements CommandRunner {
  constructor(private readonly timeoutMs = 8000) {}

  run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { cwd, timeout: this.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ code: -1, stdout: '', stderr: 'git executable not found' });
            return;
          }
          const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : error ? 1 : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (error?.message ?? '') });
        }
      );
    });
  }
}
