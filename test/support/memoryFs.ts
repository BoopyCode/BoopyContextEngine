import { DirEntry, FileNotFoundError, FileStat, FileSystemLike, WorkspaceEscapeError } from '../../src/core/io/fs';
import { baseName, dirOf, joinRel, normalizeRel } from '../../src/core/util/paths';

export interface MemoryFile {
  type: 'file';
  content: string;
  mtimeMs?: number;
}

export interface MemoryDir {
  type: 'dir';
}

export interface MemorySymlink {
  type: 'symlink';
  /** Workspace-relative target, or an absolute/escaping target to simulate an attack. */
  target: string;
}

export type MemoryNode = MemoryFile | MemoryDir | MemorySymlink;

/**
 * Virtual file system used by the scan/ignore/safety tests. It can represent
 * symbolic links that escape the root, which is impossible to set up portably on
 * Windows with real links.
 */
export class MemoryFileSystem implements FileSystemLike {
  readonly supportsRealPath = true;
  readonly rootDisplayPath: string;
  private readonly nodes = new Map<string, MemoryNode>();

  constructor(entries: Record<string, MemoryNode | string>, rootDisplayPath = '/memory-root') {
    this.rootDisplayPath = rootDisplayPath;
    this.nodes.set('', { type: 'dir' });
    for (const [key, value] of Object.entries(entries)) {
      const relPath = normalizeRel(key);
      this.nodes.set(relPath, typeof value === 'string' ? { type: 'file', content: value, mtimeMs: 1000 } : value);
    }
  }

  get files(): string[] {
    return [...this.nodes.entries()].filter(([, node]) => node.type === 'file').map(([key]) => key);
  }

  set(relPath: string, node: MemoryNode | string): void {
    this.nodes.set(normalizeRel(relPath), typeof node === 'string' ? { type: 'file', content: node, mtimeMs: Date.now() } : node);
  }

  delete(relPath: string): void {
    this.nodes.delete(normalizeRel(relPath));
  }

  async readText(relPath: string): Promise<string> {
    const node = await this.follow(relPath);
    if (node.type !== 'file') {
      throw new Error(`not a file: ${relPath}`);
    }
    return node.content;
  }

  async readHead(relPath: string, bytes: number): Promise<string> {
    const content = await this.readText(relPath);
    return content.slice(0, bytes);
  }

  async stat(relPath: string): Promise<FileStat> {
    const node = this.require(relPath);
    if (node.type === 'dir') {
      return { size: 0, mtimeMs: 1000, isDirectory: true, isFile: false, isSymbolicLink: false };
    }
    if (node.type === 'symlink') {
      return { size: 0, mtimeMs: 1000, isDirectory: false, isFile: false, isSymbolicLink: true };
    }
    return { size: node.content.length, mtimeMs: node.mtimeMs ?? 1000, isDirectory: false, isFile: true, isSymbolicLink: false };
  }

  async list(relPath: string): Promise<DirEntry[]> {
    const dir = normalizeRel(relPath);
    const prefix = dir === '' ? '' : `${dir}/`;
    const seen = new Map<string, DirEntry>();
    for (const [key, node] of this.nodes) {
      if (!key.startsWith(prefix) || key === dir) {
        continue;
      }
      const rest = key.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) {
        continue;
      }
      seen.set(rest, {
        name: rest,
        isDirectory: node.type === 'dir',
        isFile: node.type === 'file',
        isSymbolicLink: node.type === 'symlink'
      });
    }
    return [...seen.values()];
  }

  async exists(relPath: string): Promise<boolean> {
    return this.nodes.has(normalizeRel(relPath));
  }

  async resolveWithinRoot(relPath: string): Promise<string> {
    const normalized = normalizeRel(relPath);
    const node = this.nodes.get(normalized);
    if (!node || node.type !== 'symlink') {
      return normalized;
    }
    const target = node.target;
    if (/^([a-zA-Z]:[\\/]|\/)/.test(target) || target.startsWith('..')) {
      throw new WorkspaceEscapeError(relPath);
    }
    return normalizeRel(target);
  }

  private require(relPath: string): MemoryNode {
    const normalized = normalizeRel(relPath);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw new FileNotFoundError(relPath);
    }
    return node;
  }

  /** Resolves in-workspace symbolic links, so tests can read through them. */
  private async follow(relPath: string): Promise<MemoryNode> {
    const node = this.require(relPath);
    if (node.type !== 'symlink') {
      return node;
    }
    const target = await this.resolveWithinRoot(relPath);
    return this.require(target);
  }
}

/** In-memory StoreFs for IndexStore tests. */
export class MemoryStoreFs {
  private readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.files.set(normalizeRel(key), value);
    }
  }

  async readText(relPath: string): Promise<string> {
    const key = normalizeRel(relPath);
    const value = this.files.get(key);
    if (value === undefined) {
      throw new FileNotFoundError(relPath);
    }
    return value;
  }

  async writeTextAtomic(relPath: string, content: string): Promise<void> {
    const key = normalizeRel(relPath);
    this.files.set(key, content);
    this.writes.push(key);
  }

  async exists(relPath: string): Promise<boolean> {
    return this.files.has(normalizeRel(relPath));
  }

  async remove(relPath: string): Promise<void> {
    const key = normalizeRel(relPath);
    for (const existing of [...this.files.keys()]) {
      if (existing === key || existing.startsWith(`${key}/`)) {
        this.files.delete(existing);
      }
    }
  }

  async mkdirp(): Promise<void> {
    // directories are implicit
  }

  async list(relPath: string): Promise<string[]> {
    const dir = normalizeRel(relPath);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const head = rest.split('/')[0];
      if (head.length > 0) {
        names.add(head);
      }
    }
    return [...names];
  }

  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    const key = normalizeRel(relPath);
    const value = this.files.get(key);
    return value === undefined ? undefined : { mtimeMs: 1000, size: value.length };
  }

  content(relPath: string): string | undefined {
    return this.files.get(normalizeRel(relPath));
  }

  set(relPath: string, content: string): void {
    this.files.set(normalizeRel(relPath), content);
  }

  keys(): string[] {
    return [...this.files.keys()];
  }
}

/** Builds the parent directory entries for a flat list of file paths. */
export function withDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    let dir = dirOf(path);
    while (dir.length > 0) {
      dirs.add(dir);
      dir = dirOf(dir);
    }
  }
  return [...dirs];
}

export function fileName(path: string): string {
  return baseName(path);
}

export function join(...parts: string[]): string {
  return joinRel(...parts);
}
