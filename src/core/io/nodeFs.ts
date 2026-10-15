import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertRelativeSafe, DirEntry, FileNotFoundError, FileStat, FileSystemLike, WorkspaceEscapeError } from './fs';
import { normalizeRel, toPosix } from '../util/paths';

/**
 * Node.js backed file system access for local and remote (SSH/WSL/containers)
 * workspace extension hosts, where the project is a real directory on disk.
 */
export class NodeFileSystem implements FileSystemLike {
  readonly supportsRealPath = true;

  constructor(readonly rootDisplayPath: string, private readonly rootPath: string = rootDisplayPath) {}

  private absolute(relPath: string): string {
    assertRelativeSafe(relPath);
    return path.join(this.rootPath, normalizeRel(relPath).split('/').join(path.sep));
  }

  private relative(absPath: string): string {
    return toPosix(path.relative(this.rootPath, absPath));
  }

  async readText(relPath: string): Promise<string> {
    try {
      return await fs.readFile(this.absolute(relPath), 'utf8');
    } catch (error) {
      throw toFsError(error, relPath);
    }
  }

  async readHead(relPath: string, bytes: number): Promise<string> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.absolute(relPath), 'r');
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      throw toFsError(error, relPath);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async stat(relPath: string): Promise<FileStat> {
    try {
      const stats = await fs.lstat(this.absolute(relPath));
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        isSymbolicLink: stats.isSymbolicLink()
      };
    } catch (error) {
      throw toFsError(error, relPath);
    }
  }

  async list(relPath: string): Promise<DirEntry[]> {
    try {
      const entries = await fs.readdir(this.absolute(relPath), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink()
      }));
    } catch (error) {
      throw toFsError(error, relPath);
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.lstat(this.absolute(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async resolveWithinRoot(relPath: string): Promise<string> {
    const absolute = this.absolute(relPath);
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      return normalizeRel(relPath);
    }
    const realRoot = await fs.realpath(this.rootPath).catch(() => this.rootPath);
    const relativeReal = path.relative(realRoot, real);
    if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
      throw new WorkspaceEscapeError(relPath);
    }
    return normalizeRel(this.relative(real));
  }
}

function toFsError(error: unknown, relPath: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FileNotFoundError(relPath);
  }
  return error instanceof Error ? error : new Error(String(error));
}
