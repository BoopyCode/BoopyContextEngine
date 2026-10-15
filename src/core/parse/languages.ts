import { extName, baseName } from '../util/paths';
import { FileKind, LanguageId } from '../types';

export interface LanguageInfo {
  language: LanguageId;
  /** Parser that will be used, `none` means the file is only inventoried. */
  parser: 'tsjs' | 'php' | 'python' | 'sql' | 'json' | 'markdown' | 'yaml' | 'dockerfile' | 'text' | 'none';
}

const EXTENSION_MAP: Record<string, LanguageInfo> = {
  '.ts': { language: 'typescript', parser: 'tsjs' },
  '.tsx': { language: 'typescript', parser: 'tsjs' },
  '.mts': { language: 'typescript', parser: 'tsjs' },
  '.cts': { language: 'typescript', parser: 'tsjs' },
  '.js': { language: 'javascript', parser: 'tsjs' },
  '.jsx': { language: 'javascript', parser: 'tsjs' },
  '.mjs': { language: 'javascript', parser: 'tsjs' },
  '.cjs': { language: 'javascript', parser: 'tsjs' },
  '.vue': { language: 'typescript', parser: 'tsjs' },
  '.php': { language: 'php', parser: 'php' },
  '.phtml': { language: 'php', parser: 'php' },
  '.php5': { language: 'php', parser: 'php' },
  '.py': { language: 'python', parser: 'python' },
  '.pyi': { language: 'python', parser: 'python' },
  '.sql': { language: 'sql', parser: 'sql' },
  '.pgsql': { language: 'sql', parser: 'sql' },
  '.mysql': { language: 'sql', parser: 'sql' },
  '.json': { language: 'json', parser: 'json' },
  '.jsonc': { language: 'json', parser: 'json' },
  '.md': { language: 'markdown', parser: 'markdown' },
  '.markdown': { language: 'markdown', parser: 'markdown' },
  '.yml': { language: 'yaml', parser: 'yaml' },
  '.yaml': { language: 'yaml', parser: 'yaml' },
  '.html': { language: 'html', parser: 'none' },
  '.htm': { language: 'html', parser: 'none' },
  '.twig': { language: 'html', parser: 'none' },
  '.blade.php': { language: 'php', parser: 'none' },
  '.css': { language: 'css', parser: 'none' },
  '.scss': { language: 'css', parser: 'none' },
  '.sass': { language: 'css', parser: 'none' },
  '.less': { language: 'css', parser: 'none' },
  '.sh': { language: 'shell', parser: 'none' },
  '.bash': { language: 'shell', parser: 'none' },
  '.ps1': { language: 'shell', parser: 'none' },
  '.tf': { language: 'other', parser: 'none' },
  '.tfvars': { language: 'other', parser: 'none' },
  '.xml': { language: 'other', parser: 'none' },
  '.graphql': { language: 'other', parser: 'none' },
  '.ini': { language: 'other', parser: 'text' },
  '.cfg': { language: 'other', parser: 'text' },
  '.conf': { language: 'other', parser: 'text' },
  '.properties': { language: 'other', parser: 'text' },
  '.toml': { language: 'other', parser: 'text' },
  '.txt': { language: 'other', parser: 'text' },
  '.editorconfig': { language: 'other', parser: 'text' },
  '.gitignore': { language: 'other', parser: 'text' },
  '.bceignore': { language: 'other', parser: 'text' }
};

const FILENAME_MAP: Record<string, LanguageInfo> = {
  dockerfile: { language: 'dockerfile', parser: 'dockerfile' },
  'docker-compose.yml': { language: 'yaml', parser: 'yaml' },
  'docker-compose.yaml': { language: 'yaml', parser: 'yaml' },
  'compose.yml': { language: 'yaml', parser: 'yaml' },
  'compose.yaml': { language: 'yaml', parser: 'yaml' },
  makefile: { language: 'other', parser: 'text' },
  gemfile: { language: 'other', parser: 'text' },
  '.env.example': { language: 'other', parser: 'text' }
};

export function detectLanguage(relPath: string): LanguageInfo {
  const lower = baseName(relPath).toLowerCase();
  if (lower === 'blade.php') {
    return { language: 'php', parser: 'none' };
  }
  if (lower.endsWith('.blade.php')) {
    return { language: 'php', parser: 'none' };
  }
  if (lower.startsWith('dockerfile')) {
    return { language: 'dockerfile', parser: 'dockerfile' };
  }
  if (lower.endsWith('.d.ts')) {
    return { language: 'typescript', parser: 'tsjs' };
  }
  const direct = FILENAME_MAP[lower];
  if (direct) {
    return direct;
  }
  const ext = extName(relPath);
  return EXTENSION_MAP[ext] ?? { language: 'other', parser: 'none' };
}

const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /Test\.php$/,
  /\.test\.php$/i,
  /^test_.*\.py$/,
  /_test\.py$/,
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//i,
  /\.sql$/i
];

const MIGRATION_PATTERNS: RegExp[] = [/(^|\/)migrations?\//i, /(^|\/)migrate\//i, /^\d{8,14}[-_].*\.(sql|php|py|js|ts)$/i];

const CONFIG_FILES = new Set([
  'package.json',
  'composer.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'phpunit.xml',
  'phpunit.xml.dist',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.js',
  'jest.config.ts',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.js',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  'pytest.ini',
  'tox.ini',
  '.bceignore',
  'settings.gradle',
  'build.gradle',
  'pom.xml',
  'cargo.toml',
  'go.mod'
]);

const PROJECT_INSTRUCTION_FILES = new Set([
  'readme.md',
  'readme.markdown',
  'contributing.md',
  'agents.md',
  'claude.md',
  'gemini.md',
  'copilot-instructions.md',
  '.cursorrules',
  'architecture.md',
  'docs/architecture.md',
  'docs/readme.md'
]);

export function isTestLikePath(relPath: string, kind?: FileKind): boolean {
  if (kind === 'test') {
    return true;
  }
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.sql')) {
    return /(^|\/)(test|tests|fixtures)\//i.test(lower);
  }
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(relPath));
}

export function isMigrationPath(relPath: string): boolean {
  return MIGRATION_PATTERNS.some((pattern) => pattern.test(relPath));
}

export function isConfigFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.startsWith('.github/workflows/')) {
    return true;
  }
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return true;
  }
  return CONFIG_FILES.has(baseName(lower));
}

export function isProjectInstructionFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = baseName(lower);
  if (lower.startsWith('.github/') && lower.includes('copilot-instructions')) {
    return true;
  }
  return PROJECT_INSTRUCTION_FILES.has(base) || PROJECT_INSTRUCTION_FILES.has(lower);
}

export function classifyFile(relPath: string, language: LanguageId): FileKind {
  const lower = relPath.toLowerCase();
  const ext = extName(lower);

  if (isTestLikePath(relPath)) {
    return 'test';
  }
  if (isMigrationPath(relPath)) {
    return 'migration';
  }
  if (isProjectInstructionFile(relPath)) {
    return 'doc';
  }
  if (isConfigFile(relPath)) {
    return 'config';
  }
  if (ext === '.sql') {
    return /schema|structure|database/i.test(lower) ? 'schema' : 'source';
  }
  if (language === 'markdown' || language === 'other' || language === 'json') {
    return 'doc';
  }
  if (language === 'css') {
    return 'style';
  }
  if (language === 'html') {
    return 'template';
  }
  if (language === 'yaml' || language === 'dockerfile') {
    return 'config';
  }
  return 'source';
}

/** Maps a test file to the most likely tested source file. */
export function inferredTestedPath(relPath: string): string | undefined {
  const lower = relPath;
  let candidate: string | undefined;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(lower)) {
    candidate = lower.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/i, '$2');
  } else if (/Test\.php$/.test(lower)) {
    candidate = lower.replace(/Test\.php$/, '.php');
  } else if (/\.test\.php$/i.test(lower)) {
    candidate = lower.replace(/\.test\.php$/i, '.php');
  } else if (/^test_(.*)\.py$/.test(baseName(lower))) {
    candidate = lower.replace(/test_([^/]*)\.py$/, '$1.py');
  } else if (/_test\.py$/.test(lower)) {
    candidate = lower.replace(/_test\.py$/, '.py');
  } else {
    const match = /^(.*)\/tests?\/(.*)$/i.exec(lower);
    if (match) {
      candidate = `${match[1]}/${match[2]}`;
    }
  }
  return candidate;
}

/** Returns true when the file looks like a lint/test configuration for the project. */
export function isTestConfigFile(relPath: string): boolean {
  const lower = baseName(relPath).toLowerCase();
  return (
    lower === 'phpunit.xml' ||
    lower === 'phpunit.xml.dist' ||
    lower === 'pytest.ini' ||
    lower === 'vitest.config.ts' ||
    lower === 'vitest.config.js' ||
    lower === 'jest.config.js' ||
    lower === 'jest.config.ts' ||
    lower === 'tox.ini' ||
    lower === 'karma.conf.js' ||
    lower === 'playwright.config.ts' ||
    lower === 'cypress.config.ts'
  );
}
