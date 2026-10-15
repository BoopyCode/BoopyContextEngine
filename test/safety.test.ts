import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { runFileContext, runFindContext, runProjectOverview } from '../src/core/tools/handlers';

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

describe('path safety', () => {
  it('accepts workspace relative paths that point at indexed files', async () => {
    const h = await harness();
    await h.work();
    const resolution = h.intelligence.resolvePath('src/index.ts');
    expect(resolution.ok).toBe(true);
    expect(resolution.relPath).toBe('src/index.ts');
    expect(await h.intelligence.readFile('src/index.ts')).toContain('createServer');
  });

  it('accepts absolute paths inside the workspace', async () => {
    const h = await harness();
    await h.work();
    const absolute = `${h.root}${process.platform === 'win32' ? '\\' : '/'}src${process.platform === 'win32' ? '\\' : '/'}index.ts`;
    const resolution = h.intelligence.resolvePath(absolute);
    expect(resolution.ok).toBe(true);
    expect(resolution.relPath).toBe('src/index.ts');
  });

  it('refuses absolute paths outside the workspace', async () => {
    const h = await harness();
    await h.work();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
    const resolution = h.intelligence.resolvePath(outside);
    expect(resolution.ok).toBe(false);
    expect(resolution.error).toContain('outside the workspace');
  });

  it('refuses traversal attempts', async () => {
    const h = await harness();
    await h.work();
    for (const attempt of ['../../etc/passwd', '..\\..\\secrets.txt', 'src/../../../outside.txt']) {
      const resolution = h.intelligence.resolvePath(attempt);
      expect(resolution.ok).toBe(false);
    }
  });

  it('refuses secret files and explains why', async () => {
    const h = await harness();
    await h.work();
    for (const secret of ['.env', 'config/server.key', 'config/secrets.json']) {
      const resolution = h.intelligence.resolvePath(secret);
      expect(resolution.ok).toBe(false);
      expect(resolution.error).toContain('not available to BCE');
    }
    expect(await h.intelligence.readFile('.env')).toBeUndefined();
  });

  it('refuses files excluded by .gitignore, .bceignore or the built-in rules', async () => {
    const h = await harness();
    await h.work();
    expect(h.intelligence.resolvePath('generated/api-client.ts').ok).toBe(false);
    expect(h.intelligence.resolvePath('node_modules/left-pad/index.js').ok).toBe(false);
    expect(h.intelligence.resolvePath('dist/bundle.js').ok).toBe(false);
  });

  it('explains when a file is not indexed yet', async () => {
    const h = await harness();
    await h.work();
    const result = h.intelligence.fileRecord('src/does-not-exist.ts');
    expect(result.error).toContain('not part of the current index');
  });

  it('never leaks secret content into tool output', async () => {
    const h = await harness();
    await h.work();
    const find = await runFindContext(h.intelligence, { query: 'DATABASE_PASSWORD STRIPE_SECRET_KEY' });
    expect(find.text).not.toContain('super-secret-password');
    expect(find.text).not.toContain('.env ');

    const file = await runFileContext(h.intelligence, { path: '.env' });
    expect(file.text).toContain('refused');
    expect(file.text).not.toContain('super-secret-password');

    const overview = await runProjectOverview(h.intelligence, {});
    expect(overview.text).not.toContain('super-secret-password');
    expect(overview.text).not.toContain('should-never-be-indexed');
  });
});
