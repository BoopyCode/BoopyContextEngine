import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { GITIGNORE_MARKER_START, ensureBceGitIgnored } from '../src/host/gitignore';
import { createTempDir } from './support/tempProject';
import { __mock } from './mocks/vscode';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const temp = await createTempDir('bce-gitignore');
  root = temp.dir;
  cleanup = temp.cleanup;
  __mock.state.reset();
});

afterEach(async () => {
  await cleanup();
});

async function readGitignore(): Promise<string> {
  return fs.readFile(path.join(root, '.gitignore'), 'utf8');
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

describe('automatic git ignore of BCE output', () => {
  it('creates a .gitignore with a managed block in a git project', async () => {
    await fs.mkdir(path.join(root, '.git'));
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('created');
    const content = await readGitignore();
    expect(content).toContain(GITIGNORE_MARKER_START);
    expect(content).toContain('.bce/');
  });

  it('is idempotent and never duplicates entries', async () => {
    await fs.mkdir(path.join(root, '.git'));
    await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    const first = await readGitignore();
    const second = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(second).toBe('already-present');
    expect(await readGitignore()).toBe(first);
  });

  it('preserves existing content and appends the block', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n*.log\n', 'utf8');
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('updated');
    const content = await readGitignore();
    expect(content.startsWith('node_modules/\n*.log\n')).toBe(true);
    expect(content).toContain('.bce/');
  });

  it('recognizes hand written ignore entries and only adds what is missing', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), '.bce/\n', 'utf8');
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('updated');
    const content = await readGitignore();
    expect(content.startsWith('.bce/\n')).toBe(true);
    expect(content).toContain('.bce-cache/');

    await fs.writeFile(path.join(root, '.gitignore'), '.bce/\n.bce-cache/\n', 'utf8');
    const second = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(second).toBe('already-present');
    expect(await readGitignore()).toBe('.bce/\n.bce-cache/\n');
  });

  it('rewrites a damaged managed block instead of appending a second one', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), `${GITIGNORE_MARKER_START}\n# <<< Boopy Context Engine (BCE) - managed block <<<\n`, 'utf8');
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('updated');
    const content = await readGitignore();
    expect(content.match(/Boopy Context Engine \(BCE\) - managed block, do not edit/g)?.length).toBe(1);
  });

  it('does nothing when BCE is disabled or the workspace is untrusted', async () => {
    await fs.mkdir(path.join(root, '.git'));
    expect(await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: false, enabled: true, writesIntoProject: false })).toBe('skipped');
    expect(await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: false, writesIntoProject: false })).toBe('skipped');
    expect(await exists('.gitignore')).toBe(false);
  });

  it('skips projects that are not git repositories and do not get BCE output', async () => {
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('not-a-git-project');
  });

  it('creates the entry when BCE stores its index inside the project', async () => {
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: true });
    expect(outcome).toBe('created');
    expect(await readGitignore()).toContain('.bce/');
  });

  it('reports a failure instead of throwing when writing is impossible', async () => {
    await fs.mkdir(path.join(root, '.git'));
    __mock.state.failWrites = true;
    const outcome = await ensureBceGitIgnored(vscode.Uri.file(root), { trusted: true, enabled: true, writesIntoProject: false });
    expect(outcome).toBe('failed');
    __mock.state.failWrites = false;
  });
});
