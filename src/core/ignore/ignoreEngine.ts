import ignore, { type Ignore } from 'ignore';
import { baseName, isInside, normalizeRel, toPosix } from '../util/paths';
import {
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILES,
  hasBinaryExtension,
  isSecretPath
} from './patterns';

export type IgnoreSource =
  | 'bce-safety'
  | 'bce.includePaths'
  | 'bce.ignorePaths'
  | 'builtin-exclusions'
  | '.bceignore'
  | '.gitignore';

export interface IgnoreDecision {
  ignored: boolean;
  reason: string;
  source: IgnoreSource;
  /** Hard blocks can never be re-included by configuration. */
  hard: boolean;
}

export interface IgnoreEngineOptions {
  includePatterns: string[];
  ignorePatterns: string[];
  respectGitignore: boolean;
}

const NOT_IGNORED: IgnoreDecision = { ignored: false, reason: '', source: 'builtin-exclusions', hard: false };

/** A parsed ignore file that applies to a directory and everything below it. */
interface IgnoreLayer {
  /** Workspace-relative directory the layer was loaded from (`''` for the root). */
  base: string;
  /** Number of path segments in `base`, used to pop layers while walking. */
  depth: number;
  source: '.bceignore' | '.gitignore';
  matcher: Ignore;
}

function compile(patterns: string[]): Ignore {
  const matcher = ignore();
  matcher.add(patterns);
  return matcher;
}

/**
 * Decides whether a workspace-relative path may be indexed.
 *
 * Precedence (first match wins):
 *   1. safety blocks (secrets, binary payloads) - always ignored, never overridable
 *   2. `bce.includePaths`     - explicit re-include, overrides soft exclusions
 *   3. `bce.ignorePaths`      - user exclusions
 *   4. built-in noise exclusions
 *   5. nested `.bceignore` layers
 *   6. nested `.gitignore` layers (when `bce.respectGitignore` is on)
 */
export class IgnoreEngine {
  private readonly include: Ignore;
  private readonly extraIgnore: Ignore;
  private readonly builtinDirs: Ignore;
  private readonly builtinFiles: Ignore;
  private layers: IgnoreLayer[] = [];

  constructor(private readonly options: IgnoreEngineOptions) {
    this.include = compile(options.includePatterns);
    this.extraIgnore = compile(options.ignorePatterns);
    this.builtinDirs = compile(DEFAULT_EXCLUDED_DIRS.flatMap((dir) => [dir, `${dir}/`]));
    this.builtinFiles = compile(DEFAULT_EXCLUDED_FILES);
  }

  get respectGitignore(): boolean {
    return this.options.respectGitignore;
  }

  /** Resets all layers, used before a fresh walk. */
  resetLayers(): void {
    this.layers = [];
  }

  /** Pops layers that are no longer relevant for the current directory. */
  popToDepth(depth: number): void {
    while (this.layers.length > 0 && this.layers[this.layers.length - 1].depth > depth) {
      this.layers.pop();
    }
  }

  pushLayer(base: string, patterns: string[], source: '.bceignore' | '.gitignore'): void {
    const filtered = patterns.filter((line) => line.trim().length > 0);
    if (filtered.length === 0) {
      return;
    }
    const normalizedBase = normalizeRel(base);
    this.layers.push({
      base: normalizedBase,
      depth: normalizedBase === '' ? 0 : normalizedBase.split('/').length,
      source,
      matcher: compile(filtered)
    });
  }

  /** Decides for a directory; the path must not have a trailing slash. */
  checkDirectory(relDir: string): IgnoreDecision {
    const relPath = normalizeRel(relDir);
    if (relPath === '') {
      return NOT_IGNORED;
    }
    const decision = this.decide(relPath, true);
    return decision;
  }

  /** Decides for a file or a directory. */
  check(relPath: string, isDirectory: boolean = false): IgnoreDecision {
    const normalized = normalizeRel(relPath);
    if (normalized === '') {
      return NOT_IGNORED;
    }
    return this.decide(normalized, isDirectory);
  }

  private decide(relPath: string, isDirectory: boolean): IgnoreDecision {
    if (isSecretPath(relPath)) {
      return {
        ignored: true,
        reason: 'safety block: possible secret, credential or private key file',
        source: 'bce-safety',
        hard: true
      };
    }
    if (hasBinaryExtension(relPath)) {
      return {
        ignored: true,
        reason: 'safety block: binary file',
        source: 'bce-safety',
        hard: true
      };
    }
    if (this.matches(this.include, relPath, isDirectory)) {
      return { ignored: false, reason: 're-included by bce.includePaths', source: 'bce.includePaths', hard: false };
    }
    if (isDirectory && this.includeMatchesBelow(relPath)) {
      // A pattern such as `dist/**` matches files inside the directory, not the
      // directory itself, so the walk has to descend into it.
      return { ignored: false, reason: 'contains paths re-included by bce.includePaths', source: 'bce.includePaths', hard: false };
    }
    if (this.matches(this.extraIgnore, relPath, isDirectory)) {
      return { ignored: true, reason: 'matched bce.ignorePaths', source: 'bce.ignorePaths', hard: false };
    }
    if (this.matches(this.builtinDirs, relPath, true) || this.matches(this.builtinFiles, relPath, isDirectory)) {
      return {
        ignored: true,
        reason: isDirectory ? 'built-in excluded directory' : 'built-in excluded file',
        source: 'builtin-exclusions',
        hard: false
      };
    }
    for (let index = this.layers.length - 1; index >= 0; index -= 1) {
      const layer = this.layers[index];
      if (!isInside(layer.base, relPath) || relPath === layer.base) {
        continue;
      }
      if (this.matches(layer.matcher, relPath, isDirectory, layer.base)) {
        return {
          ignored: true,
          reason: `matched ${layer.source}${layer.base === '' ? '' : ` in ${layer.base}/`}`,
          source: layer.source,
          hard: false
        };
      }
    }
    return NOT_IGNORED;
  }

  private includeMatchesBelow(relDir: string): boolean {
    if (relDir === '') {
      return false;
    }
    return this.include.ignores(`${relDir}/__bce_probe__`);
  }

  private matches(matcher: Ignore, relPath: string, isDirectory: boolean, base = ''): boolean {
    const candidate = base === '' ? relPath : relPath.slice(base.length + 1);
    if (candidate === '') {
      return false;
    }
    if (isDirectory) {
      // Git treats a directory pattern such as `dist/` as directory-only, so both
      // spellings have to be probed.
      return matcher.ignores(`${candidate}/`) || matcher.ignores(candidate);
    }
    if (matcher.ignores(candidate)) {
      return true;
    }
    return false;
  }
}

/** Splits ignore-file content into patterns, dropping comments and blank lines. */
export function parseIgnoreFile(content: string): string[] {
  return toPosix(content)
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.trim());
}

/** True when the ignore file only contains comments, so we can skip the layer. */
export function hasMeaningfulPatterns(patterns: string[]): boolean {
  return patterns.some((pattern) => pattern.trim().length > 0);
}

export function ignoreFileName(relPath: string): '.bceignore' | '.gitignore' | undefined {
  const name = baseName(relPath);
  if (name === '.bceignore') {
    return '.bceignore';
  }
  if (name === '.gitignore') {
    return '.gitignore';
  }
  return undefined;
}
