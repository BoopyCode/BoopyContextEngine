/**
 * Minimal `.env` loader for the A/B harness.
 *
 * The key lives in `.env` (git-ignored) instead of an environment variable that has to be
 * re-exported in every shell. Nothing here is logged: a load reports only which names were
 * picked up, never their values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads `<repo>/.env` and fills any variable that is not already set. Returns the names loaded. */
export function loadEnv(file = join(root, '.env')) {
  if (!existsSync(file)) {
    return [];
  }
  const loaded = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, name, rawValue] = match;
    // A real environment variable always wins, so CI can override without editing files.
    if (process.env[name] !== undefined) {
      continue;
    }
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    if (value.length === 0) {
      continue;
    }
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
