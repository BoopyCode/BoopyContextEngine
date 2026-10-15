import { PersistedContextCacheEntry, PersistedIndex, ProjectMap } from '../types';
import { SCHEMA_VERSION } from '../parse/registry';
import { StoreFs } from '../io/storeFs';
import { ProjectIndex } from './indexModel';

export const INDEX_FILE = 'index.json';
export const CONTEXT_CACHE_FILE = 'context-cache.json';
export const LOCK_FILE = 'index.lock';
export const MAP_DIR = 'map';
const LOCK_STALE_MS = 15000;

export interface LoadExpectation {
  rootKey: string;
  parserVersion: string;
  configSignature: string;
}

export type LoadResult =
  | { status: 'loaded'; index: ProjectIndex; contextCache: Record<string, PersistedContextCacheEntry>; droppedContextCache: boolean }
  | { status: 'missing'; reason: string }
  | { status: 'incompatible'; reason: string }
  | { status: 'corrupt'; reason: string };

export interface SaveResult {
  ok: boolean;
  reason?: string;
}

/**
 * Persistence for the index, the project map and both cache layers.
 *
 * Writes are atomic (temp file + rename) so a crashed or killed VS Code window can
 * never leave a half written index behind, and a lock file keeps two windows that
 * share the same storage from writing at the same time.
 */
export class IndexStore {
  constructor(
    private readonly fs: StoreFs,
    private readonly clock: { now(): number } = { now: () => Date.now() },
    private readonly pid: number = typeof process === 'undefined' ? 0 : process.pid
  ) {}

  async load(expectation: LoadExpectation): Promise<LoadResult> {
    if (!(await this.fs.exists(INDEX_FILE))) {
      return { status: 'missing', reason: 'no index found yet' };
    }
    let raw: string;
    try {
      raw = await this.fs.readText(INDEX_FILE);
    } catch (error) {
      return { status: 'corrupt', reason: `index file could not be read: ${describe(error)}` };
    }

    let persisted: PersistedIndex;
    try {
      persisted = JSON.parse(raw) as PersistedIndex;
    } catch (error) {
      await this.quarantine(describe(error));
      return { status: 'corrupt', reason: `index file was not valid JSON (${describe(error)})` };
    }

    if (typeof persisted !== 'object' || persisted === null || !Array.isArray(persisted.files)) {
      await this.quarantine('unexpected index structure');
      return { status: 'corrupt', reason: 'index file had an unexpected structure' };
    }
    if (persisted.schemaVersion !== SCHEMA_VERSION) {
      return { status: 'incompatible', reason: `index schema ${persisted.schemaVersion} does not match ${SCHEMA_VERSION}` };
    }
    if (persisted.rootKey !== expectation.rootKey) {
      return { status: 'incompatible', reason: 'index belongs to a different workspace' };
    }
    if (persisted.parserVersion !== expectation.parserVersion) {
      return { status: 'incompatible', reason: 'parsers changed since the index was written' };
    }

    const index = ProjectIndex.fromPersisted(persisted);
    const contextCache = await this.loadContextCache();
    const droppedContextCache = expectation.configSignature !== persisted.configSignature;

    return {
      status: 'loaded',
      index,
      contextCache: droppedContextCache ? {} : contextCache,
      droppedContextCache
    };
  }

  async loadContextCache(): Promise<Record<string, PersistedContextCacheEntry>> {
    if (!(await this.fs.exists(CONTEXT_CACHE_FILE))) {
      return {};
    }
    try {
      const parsed = JSON.parse(await this.fs.readText(CONTEXT_CACHE_FILE)) as {
        schemaVersion?: number;
        entries?: Record<string, PersistedContextCacheEntry>;
      };
      if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.entries !== 'object') {
        await this.fs.remove(CONTEXT_CACHE_FILE).catch(() => undefined);
        return {};
      }
      return parsed.entries ?? {};
    } catch {
      await this.fs.remove(CONTEXT_CACHE_FILE).catch(() => undefined);
      return {};
    }
  }

  async saveContextCache(entries: Record<string, PersistedContextCacheEntry>): Promise<void> {
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries });
    await this.fs.writeTextAtomic(CONTEXT_CACHE_FILE, payload);
  }

  async save(index: ProjectIndex, contextCache: Record<string, PersistedContextCacheEntry>): Promise<SaveResult> {
    const lock = await this.acquireLock();
    if (!lock) {
      return { ok: false, reason: 'another VS Code window holds the BCE index lock for this workspace' };
    }
    try {
      const persisted = index.toPersisted(contextCache);
      await this.fs.writeTextAtomic(INDEX_FILE, JSON.stringify(persisted));
      await this.saveContextCache(contextCache);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `index could not be written: ${describe(error)}` };
    } finally {
      await this.releaseLock();
    }
  }

  async saveMap(map: ProjectMap): Promise<SaveResult> {
    try {
      const overview = { ...map.overview, tokensNote: undefined };
      await this.fs.writeTextAtomic(`${MAP_DIR}/project-overview.json`, JSON.stringify(overview, null, 2));
      await this.fs.writeTextAtomic(
        `${MAP_DIR}/modules.json`,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, indexVersion: map.indexVersion, updatedAt: map.updatedAt, modules: map.overview.modules }, null, 2)
      );
      await this.fs.writeTextAtomic(`${MAP_DIR}/dependencies.json`, JSON.stringify(map.dependencies, null, 2));
      await this.fs.writeTextAtomic(`${MAP_DIR}/database-schema.json`, JSON.stringify(map.databaseSchema, null, 2));
      await this.fs.writeTextAtomic(
        `${MAP_DIR}/entry-points.json`,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, indexVersion: map.indexVersion, updatedAt: map.updatedAt, entryPoints: map.entryPoints }, null, 2)
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `project map could not be written: ${describe(error)}` };
    }
  }

  async readMap(fileName: string): Promise<string | undefined> {
    const relPath = `${MAP_DIR}/${fileName}`;
    if (!(await this.fs.exists(relPath))) {
      return undefined;
    }
    try {
      return await this.fs.readText(relPath);
    } catch {
      return undefined;
    }
  }

  async listMapFiles(): Promise<string[]> {
    return this.fs.list(MAP_DIR);
  }

  async clear(): Promise<void> {
    await this.fs.remove(INDEX_FILE).catch(() => undefined);
    await this.fs.remove(CONTEXT_CACHE_FILE).catch(() => undefined);
    await this.fs.remove(MAP_DIR).catch(() => undefined);
    await this.fs.remove(LOCK_FILE).catch(() => undefined);
  }

  async clearCaches(): Promise<void> {
    await this.fs.remove(CONTEXT_CACHE_FILE).catch(() => undefined);
  }

  /** Returns true when a lock could be taken (stale locks are taken over). */
  async acquireLock(): Promise<boolean> {
    const existing = await this.fs.stat(LOCK_FILE);
    if (existing) {
      const age = this.clock.now() - existing.mtimeMs;
      const stale = age > LOCK_STALE_MS;
      if (!stale) {
        const content = await this.fs.readText(LOCK_FILE).catch(() => '');
        const owner = Number.parseInt(content.split(':')[0] ?? '', 10);
        if (owner === this.pid) {
          return true;
        }
        return false;
      }
    }
    try {
      await this.fs.writeTextAtomic(LOCK_FILE, `${this.pid}:${this.clock.now()}`);
      return true;
    } catch {
      return false;
    }
  }

  async releaseLock(): Promise<void> {
    const content = await this.fs.readText(LOCK_FILE).catch(() => undefined);
    if (content && content.startsWith(`${this.pid}:`)) {
      await this.fs.remove(LOCK_FILE).catch(() => undefined);
    }
  }

  /** Moves a damaged index aside instead of silently deleting user data. */
  private async quarantine(reason: string): Promise<void> {
    try {
      const target = `index.corrupt-${this.clock.now()}.json`;
      const content = await this.fs.readText(INDEX_FILE).catch(() => '');
      await this.fs.writeTextAtomic(target, content);
      await this.fs.remove(INDEX_FILE);
      await this.fs.writeTextAtomic(`${target}.reason.txt`, reason);
    } catch {
      // Quarantine is best effort; the rebuild will continue either way.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
