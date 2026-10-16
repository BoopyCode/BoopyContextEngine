import { dirOf, extName, joinRel, normalizeRel, toPosix } from '../util/paths';
import { Confidence } from '../types';

export interface Resolution {
  path: string;
  confidence: Confidence;
}

/** One `autoload.psr-4` entry from a composer.json, already path-normalized. */
export interface Psr4Mapping {
  /** Directory of the composer.json that declared the mapping, workspace-relative. */
  baseDir: string;
  /** Namespace prefix, always ending with a backslash (`App\`). */
  prefix: string;
  /** Target directory, relative to `baseDir` (`src/`). */
  target: string;
}

const RELATIVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.php', '.py'];
const INDEX_FILES = ['index', 'mod', '__init__', 'package', 'index.php'];

/**
 * Reads `autoload.psr-4` and `autoload-dev.psr-4` from a composer.json.
 *
 * PHP projects declare where `App\Foo\Bar` lives, and without that information a
 * namespace can only be guessed - which in a normal layout (`App\` -> `src/`,
 * `App\` -> `app/`, `App\` -> `backend/src/`) fails for every single import and
 * leaves the whole import graph empty.
 */
export function parseComposerPsr4(content: string, composerPath: string): Psr4Mapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const baseDir = dirOf(normalizeRel(composerPath));
  const out: Psr4Mapping[] = [];
  for (const section of ['autoload', 'autoload-dev']) {
    const autoload = (parsed as Record<string, unknown>)[section];
    if (typeof autoload !== 'object' || autoload === null) {
      continue;
    }
    const psr4 = (autoload as Record<string, unknown>)['psr-4'];
    if (typeof psr4 !== 'object' || psr4 === null) {
      continue;
    }
    for (const [prefix, target] of Object.entries(psr4 as Record<string, unknown>)) {
      // The namespace prefix keeps its backslashes: toPosix() would turn `App\`
      // into `App/`, which never matches a PHP namespace again.
      const normalizedPrefix = prefix.trim().replace(/^\/+/, '');
      const targetValue = Array.isArray(target) ? target[0] : target;
      if (typeof targetValue !== 'string' || normalizedPrefix.length === 0) {
        continue;
      }
      out.push({
        baseDir,
        prefix: normalizedPrefix.endsWith('\\') ? normalizedPrefix : `${normalizedPrefix}\\`,
        target: toPosix(targetValue).replace(/^\.?\//, '').replace(/\/+$/, '')
      });
    }
  }
  // A root composer.json resolves to an empty baseDir, which is what we want.
  return out;
}

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
  /** PSR-4 prefixes, longest first so the most specific mapping wins. */
  private readonly psr4: Psr4Mapping[];

  constructor(paths: Iterable<string>, psr4: Psr4Mapping[] = []) {
    this.paths = new Set([...paths].map((path) => normalizeRel(path)));
    this.psr4 = [...psr4].sort((a, b) => b.prefix.length - a.prefix.length);
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

  /** Number of PSR-4 mappings in play; reported so a failed layout is visible. */
  get psr4MappingCount(): number {
    return this.psr4.length;
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

    // PSR-4 from composer.json is authoritative: it says exactly where a
    // namespace lives, so it must be tried before any guessing.
    for (const mapping of this.psr4) {
      const nsPrefix = toPosix(mapping.prefix).replace(/\\/g, '/');
      if (!asPath.startsWith(nsPrefix)) {
        continue;
      }
      const relative = asPath.slice(nsPrefix.length);
      if (relative.length === 0) {
        continue;
      }
      const candidate = joinRel(mapping.baseDir, joinRel(mapping.target, `${relative}.php`));
      if (this.paths.has(candidate)) {
        return { path: candidate, confidence: 'exact' };
      }
      // Some projects use a case that differs from the on-disk name.
      const lower = this.lowerCaseIndex.get(candidate.toLowerCase());
      if (lower) {
        return { path: lower, confidence: 'heuristic' };
      }
    }

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

  /**
   * True when a specifier is expected to point inside the workspace.
   *
   * PHP namespaces are ambiguous by shape alone: `App\Foo` and `Psr\Log\Logger`
   * look the same, but only the first one is a missing internal edge. The caller
   * therefore passes the roots of the namespaces it saw declared in the project.
   * Without that evidence every namespace counts as internal - over-reporting a
   * hole is recoverable, silently hiding one is not.
   */
  static isInternalSpecifier(specifier: string, declaredNamespaceRoots?: ReadonlySet<string>): boolean {
    if (specifier.startsWith('.') || specifier.startsWith('@') || specifier.startsWith('/')) {
      return true;
    }
    if (!specifier.includes('\\')) {
      return false;
    }
    if (!declaredNamespaceRoots || declaredNamespaceRoots.size === 0) {
      return true;
    }
    return declaredNamespaceRoots.has(specifier.split('\\')[0].trim().toLowerCase());
  }

  /** True when the specifier clearly points outside the workspace (node_modules, vendor, stdlib). */
  static isExternal(specifier: string): boolean {
    return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('\\');
  }
}
