import { CancellationLike, isCancelled } from '../util/async';
import { joinRel, normalizeRel } from '../util/paths';
import { IgnoreEngine, parseIgnoreFile } from '../ignore/ignoreEngine';
import { looksBinary } from '../ignore/patterns';
import { DirEntry, FileSystemLike, WorkspaceEscapeError } from '../io/fs';
import { classifyFile, detectLanguage, LanguageInfo } from '../parse/languages';
import { FileKind, IgnoredFile, IndexError, LanguageId } from '../types';

export interface ScanOptions {
  maxFileSizeBytes: number;
  maxFiles: number;
  followSymlinks: boolean;
  /** Maximum number of recorded ignore decisions kept for diagnostics. */
  maxIgnoredRecords?: number;
}

export interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
  language: LanguageId;
  kind: FileKind;
  parser: LanguageInfo['parser'];
}

export interface ScanResult {
  files: ScannedFile[];
  ignored: IgnoredFile[];
  errors: IndexError[];
  /** True when the walk stopped because `maxFiles` was reached. */
  truncated: boolean;
  ignoredCount: number;
  directoryCount: number;
  durationMs: number;
}

export interface ScanProgress {
  directoriesVisited: number;
  filesFound: number;
  currentDirectory: string;
}

const BINARY_SNIFF_BYTES = 2048;
const DEFAULT_MAX_IGNORED_RECORDS = 500;

interface QueuedDirectory {
  relDir: string;
  depth: number;
}

/**
 * Walks the workspace and produces a file inventory, applying `.gitignore`,
 * `.bceignore`, user patterns and the built-in safety/noise rules from
 * `IgnoreEngine`. Never follows a symbolic link out of the workspace root and
 * never reads more than a small header of unknown file types.
 */
export class ProjectScanner {
  constructor(
    private readonly fs: FileSystemLike,
    private readonly ignore: IgnoreEngine,
    private readonly options: ScanOptions,
    private readonly clock: { now(): number } = { now: () => Date.now() }
  ) {}

  async scan(token?: CancellationLike, onProgress?: (progress: ScanProgress) => void): Promise<ScanResult> {
    const startedAt = this.clock.now();
    const files: ScannedFile[] = [];
    const ignored: IgnoredFile[] = [];
    const errors: IndexError[] = [];
    const maxIgnored = this.options.maxIgnoredRecords ?? DEFAULT_MAX_IGNORED_RECORDS;
    let ignoredCount = 0;
    let truncated = false;
    let directoriesVisited = 0;

    const recordIgnored = (path: string, reason: string, source: string): void => {
      ignoredCount += 1;
      if (ignored.length < maxIgnored) {
        ignored.push({ path, reason, source });
      }
    };

    this.ignore.resetLayers();
    const queue: QueuedDirectory[] = [{ relDir: '', depth: 0 }];

    while (queue.length > 0) {
      if (isCancelled(token)) {
        break;
      }
      const current = queue.shift() as QueuedDirectory;
      this.ignore.popToDepth(current.depth);

      let entries: DirEntry[];
      try {
        entries = await this.fs.list(current.relDir);
      } catch (error) {
        errors.push({
          path: current.relDir === '' ? '.' : current.relDir,
          message: `Cannot read directory: ${describeError(error)}`,
          at: this.clock.now()
        });
        continue;
      }

      directoriesVisited += 1;
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      await this.loadIgnoreLayers(current.relDir, entries, recordIgnored);

      for (const entry of entries) {
        if (isCancelled(token)) {
          break;
        }
        const relPath = joinRel(current.relDir, entry.name);

        const decision = this.ignore.check(relPath, entry.isDirectory);
        if (decision.ignored) {
          recordIgnored(relPath, decision.reason, decision.source);
          continue;
        }

        let isDirectory = entry.isDirectory;
        let isFile = entry.isFile;

        if (entry.isSymbolicLink) {
          if (!this.options.followSymlinks) {
            recordIgnored(relPath, 'symbolic link not followed (bce.followSymlinks is false)', 'bce-safety');
            continue;
          }
          let resolved: string;
          try {
            resolved = await this.fs.resolveWithinRoot(relPath);
          } catch (error) {
            if (error instanceof WorkspaceEscapeError) {
              errors.push({ path: relPath, message: error.message, at: this.clock.now() });
              recordIgnored(relPath, 'symbolic link leaves the workspace and was refused', 'bce-safety');
            } else {
              errors.push({ path: relPath, message: `Symbolic link could not be resolved: ${describeError(error)}`, at: this.clock.now() });
              recordIgnored(relPath, 'symbolic link could not be resolved', 'bce-safety');
            }
            continue;
          }
          try {
            const targetStats = await this.fs.stat(resolved);
            isDirectory = targetStats.isDirectory;
            isFile = targetStats.isFile;
          } catch (error) {
            errors.push({ path: relPath, message: `Symbolic link target is unreadable: ${describeError(error)}`, at: this.clock.now() });
            recordIgnored(relPath, 'symbolic link target is unreadable', 'bce-safety');
            continue;
          }
        }

        if (isDirectory) {
          queue.push({ relDir: relPath, depth: current.depth + 1 });
          continue;
        }

        if (!isFile) {
          continue;
        }

        if (files.length >= this.options.maxFiles) {
          truncated = true;
          break;
        }

        const scanned = await this.inspectFile(relPath, errors);
        if (!scanned) {
          continue;
        }
        if (typeof scanned === 'string') {
          recordIgnored(relPath, scanned, 'bce-safety');
          continue;
        }
        files.push(scanned);
      }

      if (truncated) {
        break;
      }

      onProgress?.({
        directoriesVisited,
        filesFound: files.length,
        currentDirectory: current.relDir === '' ? '.' : current.relDir
      });
    }

    if (truncated) {
      errors.push({
        path: '.',
        message: `Scan stopped after reaching bce.maxFiles (${this.options.maxFiles}). Increase the limit or narrow the include patterns.`,
        at: this.clock.now()
      });
    }

    return {
      files,
      ignored,
      errors,
      truncated,
      ignoredCount,
      directoryCount: directoriesVisited,
      durationMs: this.clock.now() - startedAt
    };
  }

  private async loadIgnoreLayers(
    relDir: string,
    entries: readonly DirEntry[],
    recordIgnored: (path: string, reason: string, source: string) => void
  ): Promise<void> {
    for (const entry of entries) {
      if (!entry.isFile) {
        continue;
      }
      if (entry.name !== '.bceignore' && entry.name !== '.gitignore') {
        continue;
      }
      if (entry.name === '.gitignore' && !this.ignore.respectGitignore) {
        continue;
      }
      const relPath = joinRel(relDir, entry.name);
      let content: string;
      try {
        content = await this.fs.readText(relPath);
      } catch (error) {
        recordIgnored(relPath, `ignore file could not be read: ${describeError(error)}`, 'bce-safety');
        continue;
      }
      const patterns = parseIgnoreFile(content);
      if (patterns.length > 0) {
        this.ignore.pushLayer(relDir, patterns, entry.name);
      }
    }
  }

  /** Returns the scanned file, a string describing why it was skipped, or undefined. */
  private async inspectFile(relPath: string, errors: IndexError[]): Promise<ScannedFile | string | undefined> {
    let size = 0;
    let mtimeMs = 0;
    try {
      const stats = await this.fs.stat(relPath);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch (error) {
      errors.push({ path: relPath, message: `Cannot stat file: ${describeError(error)}`, at: this.clock.now() });
      return undefined;
    }

    if (size > this.options.maxFileSizeBytes) {
      return `file is larger than bce.maxFileSizeKb (${Math.round(size / 1024)} KB)`;
    }

    const info = detectLanguage(relPath);
    if (info.parser === 'none') {
      return { path: relPath, size, mtimeMs, language: info.language, kind: classifyFile(relPath, info.language), parser: 'none' };
    }

    try {
      const head = await this.fs.readHead(relPath, BINARY_SNIFF_BYTES);
      if (looksBinary(head)) {
        return 'safety block: binary content';
      }
    } catch (error) {
      errors.push({ path: relPath, message: `Cannot read file: ${describeError(error)}`, at: this.clock.now() });
      return undefined;
    }

    return {
      path: normalizeRel(relPath),
      size,
      mtimeMs,
      language: info.language,
      kind: classifyFile(relPath, info.language),
      parser: info.parser
    };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
