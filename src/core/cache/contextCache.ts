import { PersistedContextCacheEntry } from '../types';
import { sha1 } from '../util/hash';

export interface ContextCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  entries: number;
}

export interface CacheKeyParts {
  tool: string;
  indexVersion: number;
  configSignature: string;
  query: string;
  options?: Record<string, unknown>;
}

const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRY_AGE_MS = 30 * 60 * 1000;

/**
 * Layer 2 cache: results of searches and impact analyses together with the content
 * hashes they were computed from.
 *
 * Invalidation is dependency based: when a file changes, only the entries that
 * depend on that file are dropped. When in doubt the entry is recomputed rather
 * than served, because a stale answer costs the user more than a recomputation.
 */
export class ContextCache<T> {
  private entries: Record<string, PersistedContextCacheEntry>;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(
    entries: Record<string, PersistedContextCacheEntry> = {},
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly clock: { now(): number } = { now: () => Date.now() }
  ) {
    this.entries = { ...entries };
  }

  makeKey(parts: CacheKeyParts): string {
    return sha1(
      JSON.stringify({
        tool: parts.tool,
        indexVersion: parts.indexVersion,
        configSignature: parts.configSignature,
        query: parts.query,
        options: parts.options ?? {}
      })
    );
  }

  /**
   * Returns the cached payload when every dependency still has the recorded hash
   * and the entry is not older than the maximum age.
   */
  get(key: string, hashOf: (path: string) => string | undefined): T | undefined {
    const entry = this.entries[key];
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.clock.now() - entry.createdAt > MAX_ENTRY_AGE_MS) {
      delete this.entries[key];
      this.invalidations += 1;
      this.misses += 1;
      return undefined;
    }
    for (const [path, hash] of Object.entries(entry.deps)) {
      if (hashOf(path) !== hash) {
        delete this.entries[key];
        this.invalidations += 1;
        this.misses += 1;
        return undefined;
      }
    }
    this.hits += 1;
    return entry.payload as T;
  }

  set(key: string, deps: Record<string, string>, payload: T): void {
    this.entries[key] = { createdAt: this.clock.now(), deps, payload };
    this.prune();
  }

  /** Drops entries that depend on any of the given paths. */
  invalidatePaths(paths: readonly string[]): number {
    if (paths.length === 0) {
      return 0;
    }
    const touched = new Set(paths);
    let removed = 0;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (Object.keys(entry.deps).some((path) => touched.has(path))) {
        delete this.entries[key];
        removed += 1;
      }
    }
    this.invalidations += removed;
    return removed;
  }

  clear(): void {
    this.entries = {};
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  stats(): ContextCacheStats {
    return { hits: this.hits, misses: this.misses, invalidations: this.invalidations, entries: this.size };
  }

  snapshot(): Record<string, PersistedContextCacheEntry> {
    return { ...this.entries };
  }

  private prune(): void {
    const keys = Object.keys(this.entries);
    if (keys.length <= this.maxEntries) {
      return;
    }
    keys
      .sort((a, b) => this.entries[a].createdAt - this.entries[b].createdAt)
      .slice(0, keys.length - this.maxEntries)
      .forEach((key) => {
        delete this.entries[key];
      });
  }
}
