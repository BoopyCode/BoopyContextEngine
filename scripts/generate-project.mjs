/**
 * Deterministic synthetic project generator for BCE measurements.
 *
 * The shape is stable across runs, so index size, ranking quality and token numbers
 * can be compared between builds (for example: a development bundle before installing
 * the extension and the installed extension itself).
 *
 *   node scripts/generate-project.mjs [targetDirectory] [--modules 30]
 *
 * It also writes `.bce-benchmark.json`, the documented way to give BCE reproducible
 * benchmark tasks with known expected answers.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MODULES = readNumberArg('--modules', 30);
const SOURCES_PER_MODULE = 6;
const TESTS_PER_MODULE = 2;

function readNumberArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

const target =
  process.argv[2] && !process.argv[2].startsWith('--')
    ? path.resolve(process.argv[2])
    : path.join(os.tmpdir(), 'bce-bench-project');

const write = async (relPath, content) => {
  const file = path.join(target, ...relPath.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
};

const pad = (value, width = 2) => String(value).padStart(width, '0');

async function main() {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });

  const tasks = [];

  for (let module = 0; module < MODULES; module += 1) {
    const id = pad(module);
    const moduleDir = `src/mod${id}`;
    for (let file = 0; file < SOURCES_PER_MODULE; file += 1) {
      const serviceName = `Service${id}_${file}`;
      await write(
        `${moduleDir}/service${file}.ts`,
        `import { util${file} } from './util${file}';\nimport { Shared${id} } from '../shared/shared${id}';\n\nexport interface ${serviceName}Record {\n  id: string;\n  amountCents: number;\n}\n\n/** ${serviceName} handles module ${id} workflow ${file}. */\nexport class ${serviceName} {\n  private readonly cache = new Map<string, ${serviceName}Record>();\n\n  async load(id: string): Promise<${serviceName}Record | undefined> {\n    return this.cache.get(id);\n  }\n\n  async compute(id: string): Promise<number> {\n    const record = await this.load(id);\n    return record ? util${file}(record.amountCents) : 0;\n  }\n\n  describe(): string {\n    return \`${serviceName} \${Shared${id}.label}\`;\n  }\n}\n`
      );
      await write(`${moduleDir}/util${file}.ts`, `export function util${file}(cents: number): number {\n  return Math.round(cents * ${file + 1});\n}\n`);
    }
    await write(`src/shared/shared${id}.ts`, `export class Shared${id} {\n  static readonly label = 'shared-${id}';\n}\n`);
    for (let test = 0; test < TESTS_PER_MODULE; test += 1) {
      await write(
        `tests/mod${id}/service${test}.test.ts`,
        `import { Service${id}_${test} } from '../../src/mod${id}/service${test}';\n\ndescribe('Service${id}_${test}', () => {\n  it('computes a value', async () => {\n    const service = new Service${id}_${test}();\n    expect(await service.compute('x')).toBe(0);\n  });\n});\n`
      );
    }
    await write(
      `app/Http/Controllers/Controller${id}.php`,
      `<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Model${id};\n\n/** Handles module ${id} requests. */\nfinal class Controller${id}\n{\n    public function __construct(private readonly Model${id} $model)\n    {\n    }\n\n    public function show(int $id): array\n    {\n        return ['id' => $id, 'module' => '${id}'];\n    }\n\n    public function index(): array\n    {\n        return $this->model->all();\n    }\n}\n`
    );
    await write(
      `app/Models/Model${id}.php`,
      `<?php\n\nnamespace App\\Models;\n\nclass Model${id} extends Model\n{\n    protected $table = 'mod${id}_items';\n\n    public function all(): array\n    {\n        return [];\n    }\n}\n`
    );
    await write(
      `database/migrations/2024_01_01_000${pad(module, 3)}_create_mod${id}_items_table.php`,
      `<?php\n\nreturn new class extends Migration\n{\n    public function up(): void\n    {\n        Schema::create('mod${id}_items', function (Blueprint $table) {\n            $table->id();\n            $table->string('name');\n            $table->integer('amount_cents')->default(0);\n        });\n    }\n};\n`
    );
    await write(
      `docs/mod${id}.md`,
      `# Module ${id}\n\n## Purpose\n\nHandles workflow ${id} of the synthetic benchmark project.\n\n## Key files\n\n- \`src/mod${id}/service0.ts\`\n- \`app/Http/Controllers/Controller${id}.php\`\n`
    );

    tasks.push({
      id: `module-${id}`,
      description: `Locate the implementation of module ${id}`,
      query: `Service${id}_3 compute workflow`,
      expectedPaths: [`src/mod${id}/service3.ts`]
    });
    tasks.push({
      id: `controller-${id}`,
      description: `Find the PHP controller of module ${id}`,
      query: `Controller${id} show index`,
      expectedPaths: [`app/Http/Controllers/Controller${id}.php`]
    });
  }

  await write(
    'database/schema.sql',
    `${Array.from({ length: MODULES }, (_, module) => {
      const id = pad(module);
      return `CREATE TABLE mod${id}_items (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(120) NOT NULL,\n    amount_cents INTEGER NOT NULL DEFAULT 0,\n    created_at TIMESTAMP NOT NULL DEFAULT now()\n);\n\nCREATE INDEX mod${id}_items_name_idx ON mod${id}_items (name);\n`;
    }).join('\n')}\nCREATE VIEW mod_summary AS\n    SELECT count(*) AS total FROM mod00_items;\n`
  );

  await write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'bce-bench-project',
        version: '1.0.0',
        main: 'src/mod00/service0.ts',
        scripts: { test: 'vitest run', build: 'tsc -p .' },
        dependencies: { express: '^4.19.2' },
        devDependencies: { vitest: '^2.0.0', typescript: '^5.6.0' }
      },
      null,
      2
    )}\n`
  );
  await write(
    'composer.json',
    `${JSON.stringify({ name: 'boopy/bench', require: { 'laravel/framework': '^11.0' }, 'require-dev': { 'phpunit/phpunit': '^11.0' } }, null, 2)}\n`
  );
  await write('README.md', `# Synthetic benchmark project\n\n${MODULES} modules, generated by \`scripts/generate-project.mjs\` for BCE measurements.\n`);
  await write('.gitignore', 'node_modules/\ndist/\nvendor/\n.env\n');

  // Noise that must never reach the index: dependencies, build output, logs and secrets.
  for (let packageIndex = 0; packageIndex < 3; packageIndex += 1) {
    for (let file = 0; file < 8; file += 1) {
      await write(
        `node_modules/pkg${packageIndex}/lib/file${file}.js`,
        `module.exports = function pkg${packageIndex}file${file}(value) {\n  return value;\n};\n`
      );
    }
  }
  for (let file = 0; file < 6; file += 1) {
    await write(`dist/chunk${file}.js`, `var chunk${file} = 1;\n`);
    await write(`vendor/lib${file}.php`, `<?php\nfunction vendor_lib${file}(): int { return ${file}; }\n`);
  }
  await write('.env', 'APP_KEY=bench-secret-value\nDB_PASSWORD=bench-secret-value\n');
  await write('storage/logs/app.log', 'bench log line\n');
  await write('config/server.key', '-----BEGIN PRIVATE KEY-----\nbench-secret-value\n-----END PRIVATE KEY-----\n');
  await write('.bce-cache/marker.json', '{ "generated": true }\n');
  await write('.bce/index.json', '{ "generated": true }\n');
  await write('tsconfig.json', `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, outDir: 'dist' } }, null, 2)}\n`);

  const extraTasks = [
    { id: 'sql-schema', description: 'Find the SQL schema', query: 'mod07_items table schema index', expectedPaths: ['database/schema.sql'] },
    { id: 'sql-migration', description: 'Find the migration of module 12', query: 'mod12_items migration Schema::create', expectedPaths: ['database/migrations/2024_01_01_000012_create_mod12_items_table.php'] },
    { id: 'test-lookup', description: 'Find the tests of module 4', query: 'Service04_0 test compute', expectedPaths: ['tests/mod04/service0.test.ts'] },
    { id: 'docs-lookup', description: 'Find the documentation of module 9', query: 'module 9 purpose key files', expectedPaths: ['docs/mod09.md'] }
  ];

  const benchmarkTasks = [...tasks.slice(0, 8), ...extraTasks];
  await write('.bce-benchmark.json', `${JSON.stringify({ tasks: benchmarkTasks }, null, 2)}\n`);

  const fileCount = await countFiles(target);
  console.log(JSON.stringify({ project: target, modules: MODULES, files: fileCount, tasks: benchmarkTasks.length }, null, 2));
}

async function countFiles(root) {
  let count = 0;
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        count += 1;
      }
    }
  };
  await walk(root);
  return count;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
