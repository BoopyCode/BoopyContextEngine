import { describe, expect, it } from 'vitest';
import { IgnoreEngine, parseIgnoreFile } from '../src/core/ignore/ignoreEngine';
import { ProjectScanner } from '../src/core/scan/scanner';
import { defaultWorkspaceConfig } from '../src/core/config';
import { MemoryFileSystem, MemoryNode } from './support/memoryFs';
import { isSecretPath, looksBinary } from '../src/core/ignore/patterns';

function engine(partial: Partial<{ include: string[]; ignore: string[]; respectGitignore: boolean; root: string[] }> = {}): IgnoreEngine {
  const instance = new IgnoreEngine({
    includePatterns: partial.include ?? [],
    ignorePatterns: partial.ignore ?? [],
    respectGitignore: partial.respectGitignore ?? true
  });
  if (partial.root && partial.root.length > 0) {
    instance.pushLayer('', partial.root, '.gitignore');
  }
  return instance;
}

const BASE_FILES: Record<string, string | MemoryNode> = {
  'src/index.ts': 'export const a = 1;\n',
  'src/nested/deep/file.ts': 'export const b = 2;\n',
  'node_modules/left-pad/index.js': 'module.exports = 1;\n',
  'vendor/pkg/lib.php': '<?php\n',
  'dist/bundle.js': 'console.log(1);\n',
  'build/out.txt': 'built\n',
  'coverage/index.html': '<html></html>\n',
  '.env': 'SECRET=1\n',
  '.env.example': 'SECRET=change-me\n',
  '.env.local': 'SECRET=2\n',
  'config/server.key': '-----BEGIN PRIVATE KEY-----\n',
  'config/secrets.json': '{"token":"x"}\n',
  'config/app.json': '{"name":"app"}\n',
  'deploy/id_rsa': 'key\n',
  '.npmrc': '//registry:_authToken=abc\n',
  'generated/api-client.ts': 'export const client = 1;\n',
  'image/logo.png': 'binary-ish\n',
  'docs/readme.md': '# docs\n',
  'notes.txt': 'hello\n',
  '.gitignore': 'build/\ncustomenv/\n',
  'customenv/app.config': 'export const env = 1;\n',
  '.bceignore': '# nothing\n',
  'sub/.bceignore': 'private/\n',
  'sub/private/hidden.ts': 'export const hidden = 1;\n',
  'sub/visible.ts': 'export const visible = 1;\n',
  'nested/.gitignore': 'tmp/\n',
  'nested/tmp/scratch.ts': 'export const scratch = 1;\n',
  'nested/keep.ts': 'export const keep = 1;\n',
  'big/huge.ts': `export const huge = '${'x'.repeat(4096)}';\n`,
  'link/inside.ts': { type: 'symlink', target: 'src/index.ts' },
  'link/outside.ts': { type: 'symlink', target: '../../outside/secret.ts' }
};

const DIRS = [
  'src',
  'src/nested',
  'src/nested/deep',
  'node_modules',
  'node_modules/left-pad',
  'vendor',
  'vendor/pkg',
  'dist',
  'build',
  'coverage',
  'config',
  'deploy',
  'generated',
  'image',
  'docs',
  'sub',
  'sub/private',
  'nested',
  'nested/tmp',
  'big',
  'link',
  'customenv'
];

function buildFs(): MemoryFileSystem {
  const entries: Record<string, string | MemoryNode> = { ...BASE_FILES };
  for (const dir of DIRS) {
    entries[dir] = { type: 'dir' };
  }
  return new MemoryFileSystem(entries);
}

async function scan(
  partial: Parameters<typeof engine>[0] = {},
  scanOptions: Partial<{ maxFileSizeBytes: number; maxFiles: number; followSymlinks: boolean }> = {}
) {
  const fs = buildFs();
  const scanner = new ProjectScanner(fs, engine(partial), {
    maxFileSizeBytes: scanOptions.maxFileSizeBytes ?? 2048,
    maxFiles: scanOptions.maxFiles ?? 1000,
    followSymlinks: scanOptions.followSymlinks ?? false
  });
  return { result: await scanner.scan(), fs };
}

describe('ignore patterns', () => {
  it('detects secret files but allows documented env templates', () => {
    expect(isSecretPath('.env')).toBe(true);
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('.env.example')).toBe(false);
    expect(isSecretPath('.env.sample')).toBe(false);
    expect(isSecretPath('config/server.key')).toBe(true);
    expect(isSecretPath('config/secrets.json')).toBe(true);
    expect(isSecretPath('deploy/id_rsa')).toBe(true);
    expect(isSecretPath('.npmrc')).toBe(true);
    expect(isSecretPath('src/services/apiKeys.ts')).toBe(false);
  });

  it('detects binary content by sniffing for NUL bytes', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });

  it('parses ignore files and skips comments', () => {
    expect(parseIgnoreFile('# comment\n\nnode_modules/\n!keep.ts\n')).toEqual(['node_modules/', '!keep.ts']);
  });
});

describe('project scanner', () => {
  it('indexes source files and excludes dependencies, build output and caches', async () => {
    const { result } = await scan();
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/nested/deep/file.ts');
    expect(paths).toContain('docs/readme.md');
    expect(paths).toContain('notes.txt');
    expect(paths).not.toContain('node_modules/left-pad/index.js');
    expect(paths).not.toContain('vendor/pkg/lib.php');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths).not.toContain('build/out.txt');
    expect(paths).not.toContain('coverage/index.html');
  });

  it('never indexes secrets or credentials, even when they are reachable', async () => {
    const { result } = await scan({ include: ['.env', 'config/**', 'deploy/**'] });
    const paths = result.files.map((file) => file.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.local');
    expect(paths).not.toContain('config/server.key');
    expect(paths).not.toContain('config/secrets.json');
    expect(paths).not.toContain('deploy/id_rsa');
    expect(paths).toContain('.env.example');
    expect(paths).toContain('config/app.json');
    expect(result.ignored.some((entry) => entry.path === '.env' && entry.source === 'bce-safety')).toBe(true);
  });

  it('honors nested .bceignore and nested .gitignore layers', async () => {
    const { result } = await scan({ root: ['build/'] });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('sub/visible.ts');
    expect(paths).not.toContain('sub/private/hidden.ts');
    expect(paths).not.toContain('nested/tmp/scratch.ts');
    expect(paths).toContain('nested/keep.ts');
  });

  it('lets bce.includePaths override soft exclusions but not safety blocks', async () => {
    const { result } = await scan({ include: ['generated/**', 'dist/**'] });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('generated/api-client.ts');
    expect(paths).toContain('dist/bundle.js');
  });

  it('applies bce.ignorePaths on top of everything else', async () => {
    const { result } = await scan({ ignore: ['src/**', 'docs/**'] });
    const paths = result.files.map((file) => file.path);
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('docs/readme.md');
    expect(paths).toContain('notes.txt');
    expect(result.ignored.some((entry) => entry.source === 'bce.ignorePaths')).toBe(true);
  });

  it('skips files above the size limit and binary extensions', async () => {
    const { result } = await scan({}, { maxFileSizeBytes: 1024 });
    const paths = result.files.map((file) => file.path);
    expect(paths).not.toContain('big/huge.ts');
    expect(paths).not.toContain('image/logo.png');
    expect(result.ignored.some((entry) => entry.path === 'big/huge.ts' && entry.reason.includes('larger than'))).toBe(true);
  });

  it('does not follow symbolic links unless asked, and refuses escaping links', async () => {
    const notFollowed = await scan({}, { followSymlinks: false });
    expect(notFollowed.result.files.map((file) => file.path)).not.toContain('link/inside.ts');
    expect(notFollowed.result.ignored.some((entry) => entry.path === 'link/inside.ts')).toBe(true);

    const followed = await scan({}, { followSymlinks: true });
    const followedPaths = followed.result.files.map((file) => file.path);
    expect(followedPaths).toContain('link/inside.ts');
    expect(followedPaths).not.toContain('link/outside.ts');
    expect(followed.result.errors.some((error) => error.message.includes('outside the workspace'))).toBe(true);
    expect(followed.result.ignored.some((entry) => entry.path === 'link/outside.ts' && entry.reason.includes('leaves the workspace'))).toBe(true);
  });

  it('stops at bce.maxFiles and reports why', async () => {
    const { result } = await scan({}, { maxFiles: 3 });
    expect(result.files.length).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
    expect(result.errors.some((error) => error.message.includes('bce.maxFiles'))).toBe(true);
  });

  it('respects bce.respectGitignore = false', async () => {
    const ignored = await scan();
    expect(ignored.result.files.map((file) => file.path)).not.toContain('customenv/app.config');

    const { result } = await scan({ respectGitignore: false });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('customenv/app.config');
    expect(paths).not.toContain('node_modules/left-pad/index.js');
  });

  it('records an ignore decision for every skipped file with a source', async () => {
    const { result } = await scan();
    expect(result.ignoredCount).toBeGreaterThan(0);
    for (const entry of result.ignored.slice(0, 20)) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });

  it('reports unreadable directories as errors instead of crashing', async () => {
    class BrokenFs extends MemoryFileSystem {
      override async list(relPath: string) {
        if (relPath === 'broken') {
          throw new Error('EACCES: permission denied');
        }
        return super.list(relPath);
      }
    }
    const fs = new BrokenFs({ 'a.txt': 'x', broken: { type: 'dir' }, 'broken/b.txt': 'y' });
    const scanner = new ProjectScanner(fs, engine(), { maxFileSizeBytes: 2048, maxFiles: 10, followSymlinks: false });
    const result = await scanner.scan();
    expect(result.errors.some((error) => error.message.includes('Cannot read directory'))).toBe(true);
    expect(result.files.map((file) => file.path)).toContain('a.txt');
  });

  it('defaults to the documented scan options', () => {
    expect(defaultWorkspaceConfig.maxFileSizeKb).toBe(512);
    expect(defaultWorkspaceConfig.followSymlinks).toBe(false);
    expect(defaultWorkspaceConfig.respectGitignore).toBe(true);
  });
});
