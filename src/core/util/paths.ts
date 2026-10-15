/**
 * Path helpers. All workspace-relative paths inside BCE use POSIX separators,
 * regardless of the host operating system, because they are persisted and
 * compared as strings.
 */

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function normalizeRel(value: string): string {
  const posix = toPosix(value).replace(/^\.\//, '');
  const parts: string[] = [];
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function joinRel(...parts: string[]): string {
  return normalizeRel(parts.filter((part) => part.length > 0).join('/'));
}

export function dirOf(relPath: string): string {
  const normalized = normalizeRel(relPath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function baseName(relPath: string): string {
  const normalized = normalizeRel(relPath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extName(relPath: string): string {
  const base = baseName(relPath);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index).toLowerCase();
}

export function withoutExt(relPath: string): string {
  const normalized = normalizeRel(relPath);
  const ext = extName(normalized);
  return ext.length > 0 ? normalized.slice(0, normalized.length - ext.length) : normalized;
}

/**
 * True when `relPath` is `dir` itself or lives below `dir`.
 * Both inputs must be normalized workspace-relative paths.
 */
export function isInside(dir: string, relPath: string): boolean {
  if (dir === '' || dir === '.') {
    return true;
  }
  const normalizedDir = normalizeRel(dir);
  const normalizedPath = normalizeRel(relPath);
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}

/**
 * Guards against path traversal: a relative path that escapes its root
 * (`../` beyond the root) is rejected.
 */
export function escapesRoot(relPath: string): boolean {
  let depth = 0;
  for (const part of toPosix(relPath).split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
      continue;
    }
    depth += 1;
  }
  return false;
}

export function isAbsoluteLike(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

/** Splits an identifier into lowercase word parts (camelCase, snake_case, kebab-case). */
export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}
