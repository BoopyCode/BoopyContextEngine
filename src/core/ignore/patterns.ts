/**
 * Built-in exclusions.
 *
 * Two very different kinds of exclusion exist and they must never be confused:
 *
 *  - SAFETY blocks (secrets, credentials, private keys, binary payloads, oversized
 *    files). These can never be indexed, not even through `bce.includePaths`,
 *    because indexing them would leak data into the model context.
 *  - NOISE exclusions (build output, dependencies, caches, lock files). These are
 *    only defaults; an explicit `bce.includePaths` entry can bring them back.
 */

/** Directories that are noise by default and can be re-included explicitly. */
export const DEFAULT_EXCLUDED_DIRS: string[] = [
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'Pods',
  'DerivedData',
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.hypothesis',
  '.ipynb_checkpoints',
  'site-packages',
  'dist',
  'build',
  'out',
  'output',
  'target',
  'coverage',
  'htmlcov',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.yarn',
  '.pnpm-store',
  '.gradle',
  '.dart_tool',
  '.idea',
  '.vs',
  '.vscode-test',
  '.bce',
  '.serverless',
  '.terraform',
  'tmp',
  '.tmp',
  'var/cache',
  'var/log',
  'storage/framework',
  'public/build',
  'wp-content/uploads'
];

/** File name patterns that are noise by default and can be re-included explicitly. */
export const DEFAULT_EXCLUDED_FILES: string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.bundle.css',
  '*.map',
  '*.snap',
  '*.log',
  '*.tmp',
  '*.bak',
  '*.orig',
  '*.rej',
  '*.patch',
  '*.diff',
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.obj',
  '*.a',
  '*.lib',
  '*.so',
  '*.dll',
  '*.dylib',
  '*.exe',
  '*.jar',
  '*.war',
  '*.whl',
  '*.wasm',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.dump',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.tgz',
  '*.bz2',
  '*.xz',
  '*.7z',
  '*.rar',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.ppt',
  '*.pptx',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.webp',
  '*.tiff',
  '*.ico',
  '*.icns',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.otf',
  '*.eot',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.webm',
  '*.zipx',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.eslintcache',
  '.stylelintcache',
  '.gitattributes'
];

/**
 * Safety blocks: never indexed, never overridable, never returned by a tool.
 * Matched case-insensitively against the file name and the full relative path.
 */
export const SECRET_FILE_PATTERNS: string[] = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.asc',
  '*.gpg',
  '*.jwk',
  'id_rsa',
  'id_rsa.*',
  'id_dsa',
  'id_dsa.*',
  'id_ecdsa',
  'id_ecdsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.my.cnf',
  '.htpasswd',
  'credentials.json',
  'credentials.*.json',
  '*credentials*.json',
  'secrets.json',
  'secret.json',
  'secrets.yml',
  'secrets.yaml',
  '*.secrets.json',
  '*service-account*.json',
  '*serviceaccount*.json',
  'kubeconfig',
  '.kube/config',
  '.aws/credentials',
  '.docker/config.json',
  'terraform.tfstate',
  'terraform.tfstate.backup',
  '*.ovpn',
  '*.mobileprovision',
  '*.keystore.jks'
];

/**
 * Documentation-style env files that only contain placeholders.
 * They are useful for understanding configuration and are not treated as secrets.
 */
export const ALLOWED_ENV_TEMPLATES: string[] = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.test.example'];

/** Extensions handled as binary content, never indexed. */
export const BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.jar',
  '.war',
  '.class',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.pyc',
  '.pyo',
  '.wasm',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.psd',
  '.sketch',
  '.fig',
  '.lockb'
]);

/** Returns true when a relative path or its file name matches a safety block. */
export function isSecretPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (ALLOWED_ENV_TEMPLATES.includes(name)) {
    return false;
  }
  return SECRET_FILE_PATTERNS.some((pattern) => {
    if (pattern.includes('/')) {
      return lower === pattern || lower.endsWith(`/${pattern}`);
    }
    return matchFileName(pattern, name);
  });
}

function matchFileName(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === name;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

export function hasBinaryExtension(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  const index = name.lastIndexOf('.');
  if (index <= 0) {
    return false;
  }
  return BINARY_EXTENSIONS.has(name.slice(index));
}

/** Cheap binary sniff used for unknown extensions. */
export function looksBinary(head: string): boolean {
  return head.includes('\u0000');
}
