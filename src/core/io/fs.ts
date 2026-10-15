/**
 * File system abstraction.
 *
 * BCE never touches node:fs directly outside of the Node adapter so that the whole
 * pipeline can be exercised in tests with a virtual file system, and so that a
 * remote/virtual workspace can be detected and degraded in exactly one place.
 */

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
  /** True when the entry is a symbolic link (or a reparse point on Windows). */
  isSymbolicLink: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/** Thrown when a path leaves the workspace root. */
export class WorkspaceEscapeError extends Error {
  constructor(readonly path: string) {
    super(`Refusing to access "${path}" because it resolves outside the workspace root.`);
    this.name = 'WorkspaceEscapeError';
  }
}

export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = 'FileNotFoundError';
  }
}

export interface FileSystemLike {
  /** Absolute path of the workspace root, for diagnostics only. */
  readonly rootDisplayPath: string;
  /** True when symbolic links can be resolved and validated. */
  readonly supportsRealPath: boolean;
  readText(relPath: string): Promise<string>;
  readHead(relPath: string, bytes: number): Promise<string>;
  stat(relPath: string): Promise<FileStat>;
  list(relPath: string): Promise<DirEntry[]>;
  exists(relPath: string): Promise<boolean>;
  /**
   * Resolves a path to its real location and throws `WorkspaceEscapeError` when it
   * leaves the workspace root. Returns the workspace-relative path.
   */
  resolveWithinRoot(relPath: string): Promise<string>;
}

/**
 * Rejects paths that try to leave the workspace before any file system call is
 * made. This is the first line of defence; symbolic link resolution is the second.
 */
export function assertRelativeSafe(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/');
  if (/^([a-zA-Z]:|\/\/)/.test(posix)) {
    throw new WorkspaceEscapeError(relPath);
  }
  let depth = 0;
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      depth -= 1;
      if (depth < 0) {
        throw new WorkspaceEscapeError(relPath);
      }
      continue;
    }
    depth += 1;
  }
  return relPath;
}
