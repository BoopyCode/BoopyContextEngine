import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ParserRegistry } from '../src/core/parse/registry';
import { detectLanguage, classifyFile } from '../src/core/parse/languages';
import { FIXTURE_PROJECT } from './support/tempProject';
import { ParseOutput } from '../src/core/parse/parseTypes';

const registry = new ParserRegistry();

async function parseFixture(relPath: string): Promise<ParseOutput> {
  const content = await fs.readFile(path.join(FIXTURE_PROJECT, ...relPath.split('/')), 'utf8');
  const info = detectLanguage(relPath);
  const output = registry.parse({ path: relPath, content, language: info.language, kind: classifyFile(relPath, info.language) }, info.parser);
  expect(output).toBeDefined();
  return output as ParseOutput;
}

function names(output: ParseOutput, kind?: string): string[] {
  return output.symbols.filter((symbol) => !kind || symbol.kind === kind).map((symbol) => symbol.name);
}

function symbol(output: ParseOutput, name: string) {
  return output.symbols.find((candidate) => candidate.name === name);
}

describe('parser registry', () => {
  it('reports a version for cache invalidation', () => {
    expect(registry.version).toContain('tsjs@');
    expect(registry.version).toContain('php@');
    expect(registry.version).toContain('sql@');
  });
});

describe('TypeScript parser', () => {
  let output: ParseOutput;

  beforeAll(async () => {
    output = await parseFixture('src/services/orderService.ts');
  });

  it('finds classes, methods and their container', () => {
    expect(names(output, 'class')).toContain('OrderService');
    const method = symbol(output, 'refund');
    expect(method?.kind).toBe('method');
    expect(method?.container).toBe('OrderService');
    expect(method?.line).toBeGreaterThan(0);
  });

  it('captures the doc comment above a declaration', () => {
    expect(symbol(output, 'refund')?.doc).toContain('Refunding an order is irreversible');
  });

  it('records imports and references', () => {
    const specifiers = output.imports.map((entry) => entry.specifier);
    expect(specifiers).toContain('../models/order');
    expect(specifiers).toContain('../utils/money');
    expect(output.references.some((reference) => reference.name === 'formatMoney')).toBe(true);
    expect(output.references.some((reference) => reference.name === 'NewOrder' && reference.kind === 'type')).toBe(true);
  });

  it('ignores symbols inside comments and strings', () => {
    const info = detectLanguage('test.ts');
    const parsed = registry.parse(
      {
        path: 'test.ts',
        content: [
          '// export function ghost() {}',
          'const text = "function ghost2() {}";',
          '/* class Ghost3 {} */',
          'export function real() { return 1; }',
          'export const table = `function ghost4() {}`;'
        ].join('\n'),
        language: info.language,
        kind: 'source'
      },
      info.parser
    );
    expect(parsed).toBeDefined();
    expect(names(parsed as ParseOutput)).toEqual(['real']);
  });

  it('detects express style routes', async () => {
    const index = await parseFixture('src/index.ts');
    const routes = index.symbols.filter((candidate) => candidate.kind === 'route');
    expect(routes.map((route) => `${route.detail} ${route.name}`)).toEqual(
      expect.arrayContaining(['GET /orders/:id', 'POST /orders', 'GET /users/:id'])
    );
  });

  it('marks exported functions and detects components', () => {
    const info = detectLanguage('button.tsx');
    const parsed = registry.parse(
      {
        path: 'button.tsx',
        content: 'export function Button() {\n  return <div>hi</div>;\n}\n\nexport const Counter = () => {\n  return <span>1</span>;\n};',
        language: info.language,
        kind: 'source'
      },
      info.parser
    ) as ParseOutput;
    expect(symbol(parsed, 'Button')?.exported).toBe(true);
    expect(symbol(parsed, 'Counter')?.kind).toBe('component');
  });
});

describe('PHP parser', () => {
  it('extracts namespaces, classes, methods, properties and imports', async () => {
    const output = await parseFixture('app/Http/Controllers/UserController.php');
    expect(output.facts?.namespace).toBe('App\\Http\\Controllers');
    expect(names(output, 'class')).toContain('UserController');
    const show = symbol(output, 'show');
    expect(show?.kind).toBe('method');
    expect(show?.container).toBe('UserController');
    expect(output.imports.map((entry) => entry.specifier)).toContain('App\\Models\\User');
    expect(output.symbols.some((candidate) => candidate.kind === 'const')).toBe(false);
  });

  it('extracts class properties from a model', async () => {
    const output = await parseFixture('app/Models/User.php');
    const variables = output.symbols.filter((candidate) => candidate.kind === 'variable');
    expect(variables.map((variable) => variable.name)).toEqual(expect.arrayContaining(['table', 'fillable']));
    expect(variables.every((variable) => variable.container === 'User')).toBe(true);
  });

  it('reads Laravel schema builder statements into table columns', async () => {
    const output = await parseFixture('database/migrations/2024_01_01_000000_create_users_table.php');
    const table = output.symbols.find((candidate) => candidate.kind === 'table');
    expect(table?.name).toBe('users');
    const columns = output.symbols.filter((candidate) => candidate.kind === 'column');
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['email', 'name']));
    expect(columns.every((column) => column.container === 'users')).toBe(true);
    expect(output.facts?.schemaBuilder).toBe(true);
    expect(output.facts?.laravel).toBe(true);
  });

  it('detects Laravel route declarations', async () => {
    const output = await parseFixture('routes/api.php');
    const routes = output.symbols.filter((candidate) => candidate.kind === 'route');
    expect(routes.map((route) => `${route.detail} ${route.name}`)).toEqual(expect.arrayContaining(['GET /users/{id}', 'POST /users']));
  });
});

describe('Python parser', () => {
  it('extracts classes, methods and module functions', async () => {
    const output = await parseFixture('python/analytics/orders.py');
    expect(names(output, 'class')).toContain('OrderAnalytics');
    expect(symbol(output, 'total_revenue_cents')?.container).toBe('OrderAnalytics');
    const report = symbol(output, 'build_report');
    expect(report?.kind).toBe('function');
    expect(report?.endLine).toBeGreaterThan(report?.line ?? 0);
  });
});

describe('SQL parser', () => {
  let output: ParseOutput;

  beforeAll(async () => {
    output = await parseFixture('database/schema.sql');
  });

  it('extracts tables, columns and keys', () => {
    const table = output.symbols.find((candidate) => candidate.kind === 'table');
    expect(table?.name).toBe('orders');
    const columns = output.symbols.filter((candidate) => candidate.kind === 'column').map((column) => column.name);
    expect(columns).toEqual(['id', 'user_id', 'total_cents', 'status', 'created_at']);
    expect(symbol(output, 'user_id')?.detail).toBe('BIGINT');
  });

  it('extracts views, indexes, types and foreign keys', () => {
    expect(names(output, 'view')).toContain('paid_orders');
    expect(names(output, 'index')).toContain('orders_user_id_idx');
    expect(names(output, 'type')).toContain('order_status');
    const foreignKeys = output.facts?.foreignKeys as { from: string; to: string; toColumn: string }[];
    expect(foreignKeys?.[0]).toMatchObject({ from: 'orders', to: 'users', toColumn: 'id' });
  });
});

describe('JSON, Markdown, YAML, Dockerfile and text parsers', () => {
  it('reads dependency and entry point facts from package.json', async () => {
    const output = await parseFixture('package.json');
    const facts = output.facts?.packageJson as {
      dependencies: string[];
      devDependencies: string[];
      main?: string;
      bin: string[];
      scripts: string[];
    };
    expect(facts.dependencies).toContain('express');
    expect(facts.devDependencies).toContain('vitest');
    expect(facts.main).toBe('src/index.ts');
    expect(facts.bin).toContain('bin/cli.ts');
    expect(facts.scripts).toContain('test');
  });

  it('reads composer facts', async () => {
    const output = await parseFixture('composer.json');
    const facts = output.facts?.composer as { require: string[]; requireDev: string[]; autoloadNamespaces: string[] };
    expect(facts.require).toContain('laravel/framework');
    expect(facts.requireDev).toContain('phpunit/phpunit');
    expect(facts.autoloadNamespaces).toContain('App\\');
  });

  it('extracts markdown headings exactly', async () => {
    const output = await parseFixture('README.md');
    const h1 = output.symbols.find((candidate) => candidate.detail === 'h1');
    expect(h1?.name).toBe('Sample Shop');
    expect(output.confidence).toBe('exact');
    expect(names(output, 'section')).toContain('Entry points');
  });

  it('extracts compose services and workflow jobs', async () => {
    const compose = await parseFixture('docker-compose.yml');
    expect(compose.facts?.composeServices).toEqual(['app', 'db']);
    const workflow = await parseFixture('.github/workflows/ci.yml');
    expect(workflow.facts?.workflowJobs).toEqual(['build', 'test']);
    expect(workflow.facts?.workflowTriggers).toEqual(expect.arrayContaining(['push', 'pull_request']));
  });

  it('extracts dockerfile stages', () => {
    const info = detectLanguage('Dockerfile');
    const parsed = registry.parse(
      { path: 'Dockerfile', content: 'FROM node:20 AS build\nWORKDIR /app\nEXPOSE 3000\nCMD ["node","index.js"]\n', language: info.language, kind: 'config' },
      info.parser
    ) as ParseOutput;
    expect(parsed.facts?.stages).toEqual(['build']);
    expect(parsed.facts?.exposedPorts).toEqual(['3000']);
  });

  it('reads python requirements files', () => {
    const info = detectLanguage('requirements.txt');
    const parsed = registry.parse(
      { path: 'requirements.txt', content: 'fastapi==0.110.0\n# comment\npytest>=8\n', language: info.language, kind: 'config' },
      info.parser
    ) as ParseOutput;
    expect(parsed.facts?.requirements).toEqual(['fastapi', 'pytest']);
  });
});

describe('language detection', () => {
  it('maps extensions, special filenames and blade templates', () => {
    expect(detectLanguage('src/index.ts').parser).toBe('tsjs');
    expect(detectLanguage('index.php').language).toBe('php');
    expect(detectLanguage('Dockerfile').parser).toBe('dockerfile');
    expect(detectLanguage('resources/views/home.blade.php').parser).toBe('none');
    expect(detectLanguage('image.png').parser).toBe('none');
    expect(detectLanguage('pages/index.tsx').parser).toBe('tsjs');
  });

  it('classifies file kinds', () => {
    expect(classifyFile('tests/orderService.test.ts', 'typescript')).toBe('test');
    expect(classifyFile('database/migrations/2024_x.php', 'php')).toBe('migration');
    expect(classifyFile('README.md', 'markdown')).toBe('doc');
    expect(classifyFile('package.json', 'json')).toBe('config');
    expect(classifyFile('src/index.ts', 'typescript')).toBe('source');
  });
});
