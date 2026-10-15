import { dirOf, extName, joinRel, normalizeRel, toPosix } from '../util/paths';
import { Confidence } from '../types';

export interface Resolution {
  path: string;
  confidence: Confidence;
}

const RELATIVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.php', '.py'];
const INDEX_FILES = ['index', 'mod', '__init__', 'package', 'index.php'];

/**
 * Resolves import specifiers to workspace-relative paths.
 *
 * Only relative specifiers and PSR-4 style PHP namespaces are resolved; anything
 * else is reported as external. Unresolved specifiers are kept in the index as
 * `unresolved` so the impact analysis can be honest about what it could not link.
 */
export class ImportResolver {
  private readonly paths: Set<string>;
  private readonly lowerCaseIndex = new Map<string, string>();

  constructor(paths: Iterable<string>) {
    this.paths = new Set([...paths].map((path) => normalizeRel(path)));
    for (const path of this.paths) {
      const lower = path.toLowerCase();
      if (!this.lowerCaseIndex.has(lower)) {
        this.lowerCaseIndex.set(lower, path);
      }
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      if (!this.lowerCaseIndex.has(base)) {
        this.lowerCaseIndex.set(base, path);
      }
    }
  }

  get size(): number {
    return this.paths.size;
  }

  resolve(fromPath: string, specifier: string): Resolution | undefined {
    if (specifier.length === 0) {
      return undefined;
    }
    const cleaned = specifier.split('?')[0].split('#')[0];
    if (cleaned.startsWith('.')) {
      return this.resolveRelative(fromPath, cleaned);
    }
    if (cleaned.startsWith('/')) {
      return undefined;
    }
    if (cleaned.includes('\\')) {
      return this.resolvePhpNamespace(cleaned);
    }
    // Bare specifiers resolve only when they point at a workspace package
    // (monorepo layouts) or a PHP file without namespace separators.
    return this.resolveBarePackage(cleaned);
  }

  private resolveRelative(fromPath: string, specifier: string): Resolution | undefined {
    const base = dirOf(fromPath);
    const target = joinRel(base, specifier);
    const candidates = this.candidatesFor(target);
    for (const candidate of candidates) {
      if (this.paths.has(candidate)) {
        return { path: candidate, confidence: 'exact' };
      }
    }
    const lower = this.lowerCaseIndex.get(target.toLowerCase());
    if (lower) {
      return { path: lower, confidence: 'heuristic' };
    }
    return undefined;
  }

  private candidatesFor(target: string): string[] {
    const candidates: string[] = [target];
    const ext = extName(target);
    if (ext.length === 0) {
      for (const candidateExt of RELATIVE_EXTENSIONS) {
        candidates.push(`${target}${candidateExt}`);
      }
      for (const indexFile of INDEX_FILES) {
        for (const candidateExt of RELATIVE_EXTENSIONS) {
          candidates.push(`${target}/${indexFile}${candidateExt}`);
        }
      }
    } else if (ext === '.js') {
      for (const candidateExt of ['.ts', '.tsx']) {
        candidates.push(`${target.slice(0, -3)}${candidateExt}`);
      }
    }
    return candidates;
  }

  private resolvePhpNamespace(specifier: string): Resolution | undefined {
    const asPath = toPosix(specifier).replace(/\\/g, '/');
    const candidates = [`${asPath}.php`, `${asPath}/${asPath.slice(asPath.lastIndexOf('/') + 1)}.php`];
    for (const candidate of candidates) {
      const normalized = normalizeRel(candidate);
      if (this.paths.has(normalized)) {
        return { path: normalized, confidence: 'heuristic' };
      }
    }
    // PSR-4 roots differ per project (App\ -> app/, src/, ...), so fall back to a
    // case-insensitive suffix match and mark it as a heuristic guess.
    const lowerSuffix = `/${asPath.toLowerCase()}.php`;
    for (const [lower, original] of this.lowerCaseIndex) {
      if (lower.endsWith(lowerSuffix)) {
        return { path: original, confidence: 'heuristic' };
      }
    }
    return undefined;
  }

  private resolveBarePackage(specifier: string): Resolution | undefined {
    const candidates = [
      `${specifier}.php`,
      `${specifier}/index.php`,
      `vendor/${specifier}`,
      `packages/${specifier}`,
      `app/${specifier}.php`,
      `src/${specifier}.php`
    ];
    for (const candidate of candidates) {
      const normalized = normalizeRel(candidate);
      if (this.paths.has(normalized)) {
        return { path: normalized, confidence: 'heuristic' };
      }
    }
    return undefined;
  }

  /** True when the specifier clearly points outside the workspace (node_modules, vendor, stdlib). */
  static isExternal(specifier: string): boolean {
    return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('\\');
  }
}
