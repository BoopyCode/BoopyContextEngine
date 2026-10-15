import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PROJECT = path.join(here, '..', 'fixtures', 'sample-project');

/** Copies the committed fixture project into a throwaway directory. */
export async function createTempProject(name = 'bce-fixture'): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  await copyDirectory(FIXTURE_PROJECT, dir);
  return {
    dir,
    async cleanup(): Promise<void> {
      await removeWithRetries(dir);
    }
  };
}

export async function createTempDir(prefix = 'bce-tmp'): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return {
    dir,
    async cleanup(): Promise<void> {
      await removeWithRetries(dir);
    }
  };
}

/**
 * Background indexing may still be flushing a file when a test finishes, and a writer that is
 * mid-flight can recreate the directory right after it was deleted. Removal is therefore
 * verified (and retried) instead of failing the test suite or leaking the directory.
 */
/**
 * Background indexing may still be flushing a file when a test finishes, and a writer that is
 * mid-flight can recreate the directory right after it was deleted. Removal is therefore
 * verified (and retried) instead of failing the test suite or leaking the directory.
 */
async function removeWithRetries(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
    } catch {
      // Retried below; a locked file must not fail the suite.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (!(await pathExists(dir))) {
      return;
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
      continue;
    }
    await fs.copyFile(from, to);
    await fs.utimes(to, new Date(), new Date(1_700_000_000_000));
  }
}

export async function writeFile(root: string, relPath: string, content: string, mtimeMs = Date.now()): Promise<string> {
  const target = path.join(root, ...relPath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  const seconds = mtimeMs / 1000;
  await fs.utimes(target, seconds, seconds);
  return target;
}

export async function readFile(root: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(root, ...relPath.split('/')), 'utf8');
}

export async function exists(root: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ...relPath.split('/')));
    return true;
  } catch {
    return false;
  }
}
