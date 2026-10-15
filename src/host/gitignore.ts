import * as vscode from 'vscode';

export const GITIGNORE_MARKER_START = '# >>> Boopy Context Engine (BCE) - managed block, do not edit >>>';
export const GITIGNORE_MARKER_END = '# <<< Boopy Context Engine (BCE) - managed block <<<';

/** Paths BCE may write inside a project. They must never end up in version control. */
export const BCE_PROJECT_PATHS = ['.bce/', '.bce-cache/'];

export type GitIgnoreOutcome = 'created' | 'updated' | 'already-present' | 'skipped' | 'not-a-git-project' | 'failed';

export interface GitIgnoreOptions {
  /** Writes are only attempted in trusted workspaces. */
  trusted: boolean;
  enabled: boolean;
  /** True when BCE itself writes into the project directory. */
  writesIntoProject: boolean;
}

/**
 * Makes sure the project's `.gitignore` keeps BCE output out of version control.
 *
 * The block is marked so it can be updated in place, and the function is fully
 * idempotent: running it repeatedly never duplicates entries. It never touches
 * other lines of the file.
 */
export async function ensureBceGitIgnored(root: vscode.Uri, options: GitIgnoreOptions): Promise<GitIgnoreOutcome> {
  if (!options.enabled) {
    return 'skipped';
  }
  if (!options.trusted) {
    return 'skipped';
  }

  const gitignoreUri = vscode.Uri.joinPath(root, '.gitignore');
  const existing = await readIfExists(gitignoreUri);
  const isGitProject = existing !== undefined || (await pathExists(vscode.Uri.joinPath(root, '.git')));
  if (!isGitProject && !options.writesIntoProject) {
    return 'not-a-git-project';
  }

  const content = existing ?? '';
  if (content.includes(GITIGNORE_MARKER_START)) {
    const updated = replaceManagedBlock(content);
    if (updated === content) {
      return 'already-present';
    }
    return (await write(gitignoreUri, updated)) ? 'updated' : 'failed';
  }

  if (BCE_PROJECT_PATHS.every((entry) => hasPlainEntry(content, entry))) {
    return 'already-present';
  }

  const missing = BCE_PROJECT_PATHS.filter((entry) => !hasPlainEntry(content, entry));
  const block = buildManagedBlock(missing);
  const prefix = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  const written = await write(gitignoreUri, `${content}${prefix}${block}`);
  return written ? (existing === undefined ? 'created' : 'updated') : 'failed';
}

function buildManagedBlock(entries: string[]): string {
  return [`${GITIGNORE_MARKER_START}`, ...entries, `${GITIGNORE_MARKER_END}`, ''].join('\n');
}

function replaceManagedBlock(content: string): string {
  const start = content.indexOf(GITIGNORE_MARKER_START);
  const end = content.indexOf(GITIGNORE_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    return content;
  }
  const before = content.slice(0, start);
  const after = content.slice(end + GITIGNORE_MARKER_END.length).replace(/^\n+/, '');
  const block = buildManagedBlock(BCE_PROJECT_PATHS);
  return `${before}${block}${after}`;
}

function hasPlainEntry(content: string, entry: string): boolean {
  const bare = entry.replace(/\/$/, '');
  return content
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === entry || line === bare || line === `/${entry}` || line === `/${bare}`);
}

async function readIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function write(uri: vscode.Uri, content: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return true;
  } catch {
    return false;
  }
}
