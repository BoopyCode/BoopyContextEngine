import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertRelativeSafe } from './fs';
import { dirOf, normalizeRel } from '../util/paths';

/**
 * Storage abstraction for the BCE index/map/cache directory. Kept separate from
 * `FileSystemLike` because the index may live outside the project (extension
 * storage) while still being rooted at a concrete directory.
 */
export interface StoreFs {
  readText(relPath: string): Promise<string>;
  /** Writes content so that a reader never sees a partially written file. */
  writeTextAtomic(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;
  mkdirp(relPath: string): Promise<void>;
  list(relPath: string): Promise<string[]>;
  stat(relPath: string): Promise<{ mtimeMs: number; size: number } | undefined>;
}

export class NodeStoreFs implements StoreFs {
  constructor(private readonly basePath: string) {}

  private absolute(relPath: string): string {
    assertRelativeSafe(relPath);
    return path.join(this.basePath, normalizeRel(relPath).split('/').join(path.sep));
  }

  async readText(relPath: string): Promise<string> {
    return fs.readFile(this.absolute(relPath), 'utf8');
  }

  async writeTextAtomic(relPath: string, content: string): Promise<void> {
    const absolute = this.absolute(relPath);
    const dir = dirOf(normalizeRel(relPath));
    await fs.mkdir(dir === '' ? this.basePath : this.absolute(dir), { recursive: true });
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, absolute);
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.absolute(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(this.absolute(relPath), { force: true, recursive: true });
  }

  async mkdirp(relPath: string): Promise<void> {
    await fs.mkdir(this.absolute(relPath), { recursive: true });
  }

  async list(relPath: string): Promise<string[]> {
    try {
      return await fs.readdir(this.absolute(relPath));
    } catch {
      return [];
    }
  }

  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    try {
      const stats = await fs.stat(this.absolute(relPath));
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return undefined;
    }
  }
}
