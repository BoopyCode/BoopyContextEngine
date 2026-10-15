import {
  DatabaseSchema,
  DatabaseSchemaEntry,
  DependencyGraph,
  DetectionResult,
  FileRecord,
  IndexError,
  ProjectMap,
  ProjectModule,
  ProjectOverview,
  SymbolRecord
} from '../types';
import { baseName, dirOf, extName } from '../util/paths';
import { SCHEMA_VERSION } from '../parse/registry';
import { moduleOf, ProjectIndex } from '../index/indexModel';
import { isTestConfigFile } from '../parse/languages';

const MAX_MODULES = 40;
const MAX_DB_OBJECTS = 200;
const MAX_ROUTES = 120;

interface PackageJsonFacts {
  name?: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
  main?: string;
  bin: string[];
  workspaces: string[];
}

interface ComposerFacts {
  name?: string;
  require: string[];
  requireDev: string[];
  autoloadNamespaces: string[];
  bin: string[];
}

const FRAMEWORK_HINTS: { name: string; packages: string[]; kind: 'js' | 'php' | 'python' }[] = [
  { name: 'Next.js', packages: ['next'], kind: 'js' },
  { name: 'React', packages: ['react', 'react-dom'], kind: 'js' },
  { name: 'Vue', packages: ['vue'], kind: 'js' },
  { name: 'Nuxt', packages: ['nuxt'], kind: 'js' },
  { name: 'Svelte', packages: ['svelte', '@sveltejs/kit'], kind: 'js' },
  { name: 'Angular', packages: ['@angular/core'], kind: 'js' },
  { name: 'Express', packages: ['express'], kind: 'js' },
  { name: 'NestJS', packages: ['@nestjs/core'], kind: 'js' },
  { name: 'Fastify', packages: ['fastify'], kind: 'js' },
  { name: 'Electron', packages: ['electron'], kind: 'js' },
  { name: 'Vitest', packages: ['vitest'], kind: 'js' },
  { name: 'Jest', packages: ['jest'], kind: 'js' },
  { name: 'Playwright', packages: ['@playwright/test'], kind: 'js' },
  { name: 'Cypress', packages: ['cypress'], kind: 'js' },
  { name: 'Tailwind CSS', packages: ['tailwindcss'], kind: 'js' },
  { name: 'Laravel', packages: ['laravel/framework'], kind: 'php' },
  { name: 'Symfony', packages: ['symfony/framework-bundle', 'symfony/console'], kind: 'php' },
  { name: 'Doctrine', packages: ['doctrine/orm', 'doctrine/dbal'], kind: 'php' },
  { name: 'PHPUnit', packages: ['phpunit/phpunit'], kind: 'php' },
  { name: 'WordPress', packages: ['johnpbloch/wordpress-core'], kind: 'php' }
];

const PYTHON_FRAMEWORKS: { name: string; packages: string[] }[] = [
  { name: 'Django', packages: ['django', 'djangorestframework'] },
  { name: 'Flask', packages: ['flask', 'flask-restful'] },
  { name: 'FastAPI', packages: ['fastapi', 'uvicorn'] },
  { name: 'SQLAlchemy', packages: ['sqlalchemy'] },
  { name: 'Pytest', packages: ['pytest'] }
];

const ENTRY_POINT_CANDIDATES = [
  'src/extension.ts',
  'src/index.ts',
  'src/main.ts',
  'src/app.ts',
  'src/server.ts',
  'index.ts',
  'index.js',
  'main.js',
  'server.js',
  'app.js',
  'src/index.js',
  'public/index.php',
  'index.php',
  'artisan',
  'bin/console',
  'wp-config.php',
  'manage.py',
  'main.py',
  'app.py',
  'src/main.py',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml'
];

/** Builds the project map (overview, modules, dependencies, database schema, entry points). */
export class ProjectMapBuilder {
  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {}

  build(index: ProjectIndex): ProjectMap {
    const files = index.allFiles();
    const frameworks = this.detectFrameworks(files);
    const entryPoints = this.detectEntryPoints(files);
    const databaseSchema = this.buildDatabaseSchema(index, files);
    const dependencies = this.buildDependencies(index);

    const overview: ProjectOverview = {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: index.indexVersion,
      rootName: index.rootName,
      indexedAt: index.indexedAt,
      complete: index.complete,
      partial: index.partial,
      fileCount: files.length,
      ignoredCount: index.getIgnored().length,
      languages: countLanguages(files),
      frameworks,
      entryPoints,
      configFiles: files.filter((file) => file.kind === 'config').map((file) => file.path).slice(0, 80),
      projectInstructions: files.filter((file) => isInstructionFile(file.path)).map((file) => file.path).slice(0, 40),
      databaseObjects: databaseSchema.tables
        .slice(0, MAX_DB_OBJECTS)
        .map((entry) => ({ name: entry.name, kind: entry.kind, path: entry.path, line: entry.line })),
      apiRoutes: collectRoutes(files),
      modules: this.buildModules(index),
      tests: files.filter((file) => file.kind === 'test').map((file) => ({ path: file.path, testedPath: file.testedPath })),
      testConfigFiles: files.filter((file) => isTestConfigFile(file.path)).map((file) => file.path),
      errors: index.getErrors()
    };

    return {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: index.indexVersion,
      updatedAt: this.clock.now(),
      rootName: index.rootName,
      complete: index.complete,
      partial: index.partial,
      overview,
      dependencies,
      databaseSchema,
      entryPoints
    };
  }

  private detectFrameworks(files: FileRecord[]): DetectionResult[] {
    const found = new Map<string, DetectionResult>();
    const add = (name: string, evidence: string, confidence: DetectionResult['confidence']): void => {
      if (!found.has(name)) {
        found.set(name, { name, confidence, evidence });
      }
    };

    for (const file of files) {
      const facts = file.facts ?? {};
      const packageJson = facts.packageJson as PackageJsonFacts | undefined;
      if (packageJson) {
        const all = [...packageJson.dependencies, ...packageJson.devDependencies];
        for (const hint of FRAMEWORK_HINTS) {
          for (const pkg of hint.packages) {
            if (all.includes(pkg)) {
              add(hint.name, `${file.path} depends on ${pkg}`, 'exact');
              break;
            }
          }
        }
      }
      const composer = facts.composer as ComposerFacts | undefined;
      if (composer) {
        const all = [...composer.require, ...composer.requireDev];
        for (const hint of FRAMEWORK_HINTS) {
          for (const pkg of hint.packages) {
            if (all.includes(pkg)) {
              add(hint.name, `${file.path} requires ${pkg}`, 'exact');
              break;
            }
          }
        }
      }
      const requirements = facts.requirements as string[] | undefined;
      if (requirements) {
        for (const framework of PYTHON_FRAMEWORKS) {
          for (const pkg of framework.packages) {
            if (requirements.some((requirement) => requirement.toLowerCase() === pkg)) {
              add(framework.name, `${file.path} requires ${pkg}`, 'exact');
              break;
            }
          }
        }
      }
      if (facts.djangoModels === true || facts.djangoUrls === true) {
        add('Django', `${file.path} uses Django patterns`, 'heuristic');
      }
      if (facts.flaskOrFastApi === true) {
        add('Flask/FastAPI', `${file.path} declares route decorators`, 'heuristic');
      }
      if (facts.laravel === true) {
        add('Laravel', `${file.path} uses Laravel APIs`, 'heuristic');
      }
      if (facts.schemaBuilder === true) {
        add('Laravel migrations', `${file.path} uses the schema builder`, 'heuristic');
      }
      const composeServices = facts.composeServices as string[] | undefined;
      if (composeServices && composeServices.length > 0) {
        add('Docker Compose', `${file.path} defines ${composeServices.length} service(s)`, 'exact');
      }
      if (file.language === 'dockerfile') {
        add('Docker', `${file.path} builds a container image`, 'exact');
      }
      if (facts.isWorkflow === true) {
        add('GitHub Actions', `${file.path} is a workflow`, 'exact');
      }
    }

    if (files.some((file) => file.language === 'php' && /laravel/i.test(file.facts?.namespace as string ?? ''))) {
      add('Laravel', 'PHP namespace uses App\\', 'heuristic');
    }
    if (files.some((file) => file.path.toLowerCase().startsWith('app/'))) {
      if (files.some((file) => file.path.toLowerCase().startsWith('app/http/controllers'))) {
        add('Laravel', 'app/Http/Controllers layout', 'heuristic');
      }
    }
    if (files.some((file) => baseName(file.path).toLowerCase() === 'wp-config.php')) {
      add('WordPress', 'wp-config.php present', 'exact');
    }

    return [...found.values()];
  }

  private detectEntryPoints(files: FileRecord[]): string[] {
    const paths = new Set(files.map((file) => file.path));
    const entries: string[] = [];
    for (const candidate of ENTRY_POINT_CANDIDATES) {
      if (paths.has(candidate)) {
        entries.push(candidate);
      }
    }
    for (const file of files) {
      const facts = file.facts ?? {};
      const packageJson = facts.packageJson as PackageJsonFacts | undefined;
      if (packageJson) {
        for (const bin of [packageJson.main, ...packageJson.bin].filter((value): value is string => typeof value === 'string')) {
          const normalized = bin.replace(/\\/g, '/').replace(/^\.\//, '');
          if (paths.has(normalized) && !entries.includes(normalized)) {
            entries.push(normalized);
          }
        }
      }
      const composer = facts.composer as ComposerFacts | undefined;
      if (composer) {
        for (const bin of composer.bin) {
          const normalized = bin.replace(/\\/g, '/').replace(/^\.\//, '');
          if (paths.has(normalized) && !entries.includes(normalized)) {
            entries.push(normalized);
          }
        }
      }
    }
    // Extension host entry point declared in a package.json manifest.
    for (const file of files) {
      if (baseName(file.path) === 'package.json') {
        const facts = file.facts?.packageJson as PackageJsonFacts | undefined;
        if (facts?.main && paths.has(facts.main.replace(/^\.\//, ''))) {
          const candidate = facts.main.replace(/^\.\//, '');
          if (!entries.includes(candidate)) {
            entries.push(candidate);
          }
        }
      }
    }
    return entries.slice(0, 25);
  }

  private buildModules(index: ProjectIndex): ProjectModule[] {
    const modules = index.modules();
    const dependencyEdges = index.dependencies();
    const dependentsByModule = new Map<string, Set<string>>();
    for (const edge of dependencyEdges) {
      const fromModule = moduleOf(edge.from);
      const toModule = moduleOf(edge.to);
      if (fromModule === toModule) {
        continue;
      }
      const set = dependentsByModule.get(toModule) ?? new Set<string>();
      set.add(fromModule);
      dependentsByModule.set(toModule, set);
    }

    return modules
      .map((module) => {
        const languages = [...new Set(module.files.map((file) => file.language))];
        const symbolCounts = new Map<string, number>();
        for (const file of module.files) {
          for (const symbol of file.symbols) {
            if (symbol.kind === 'column' || symbol.kind === 'section') {
              continue;
            }
            symbolCounts.set(symbol.name, (symbolCounts.get(symbol.name) ?? 0) + 1);
          }
        }
        const topSymbols = [...symbolCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([name]) => name);
        return {
          path: module.path,
          fileCount: module.files.length,
          languages,
          topSymbols,
          dependents: dependentsByModule.get(module.path)?.size ?? 0
        };
      })
      .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path))
      .slice(0, MAX_MODULES);
  }

  private buildDependencies(index: ProjectIndex): DependencyGraph {
    const edges: { from: string; to: string; confidence: 'exact' | 'heuristic' }[] = [];
    const external = new Set<string>();
    const unresolved: { from: string; specifier: string; line: number }[] = [];
    for (const file of index.allFiles()) {
      for (const dependency of file.dependencies) {
        edges.push({ from: file.path, to: dependency, confidence: 'heuristic' });
      }
      for (const importRecord of file.imports) {
        if (importRecord.resolved === undefined) {
          if (/^[.@]/.test(importRecord.specifier)) {
            unresolved.push({ from: file.path, specifier: importRecord.specifier, line: importRecord.line });
          } else {
            external.add(importRecord.specifier);
          }
        }
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: index.indexVersion,
      updatedAt: this.clock.now(),
      edges,
      externalImports: [...external].sort().slice(0, 500),
      unresolved: unresolved.slice(0, 200)
    };
  }

  private buildDatabaseSchema(index: ProjectIndex, files: FileRecord[]): DatabaseSchema {
    const tables: DatabaseSchemaEntry[] = [];
    const migrations: string[] = [];

    for (const file of files) {
      if (file.kind === 'migration') {
        migrations.push(file.path);
      }
      const tableSymbols = file.symbols.filter((symbol) => symbol.kind === 'table');
      for (const table of tableSymbols) {
        const columns: DatabaseSchemaEntry['columns'] = [];
        const references: string[] = [];
        for (const symbol of file.symbols) {
          if (symbol.container !== table.name || symbol.kind !== 'column') {
            continue;
          }
          columns.push({ name: symbol.name, type: symbol.detail });
          const reference = /references\s+([\w."`[\]]+)\s*\(/i.exec(symbol.signature ?? '');
          if (reference) {
            references.push(reference[1].replace(/[`"[\]]/g, ''));
          }
        }
        tables.push({
          name: table.name,
          kind: 'table',
          path: file.path,
          line: table.line,
          columns,
          references,
          confidence: table.confidence
        });
      }
      for (const symbol of file.symbols) {
        if (symbol.kind !== 'view' && symbol.kind !== 'index') {
          continue;
        }
        if (symbol.kind === 'view') {
          tables.push({
            name: symbol.name,
            kind: 'view',
            path: file.path,
            line: symbol.line,
            columns: [],
            references: [],
            confidence: symbol.confidence
          });
        }
      }
      const foreignKeys = (file.facts?.foreignKeys ?? []) as { from: string; to: string; toColumn?: string }[];
      for (const foreignKey of foreignKeys) {
        const entry = tables.find((table) => table.name === foreignKey.from);
        if (entry && !entry.references.includes(foreignKey.to)) {
          entry.references.push(foreignKey.to);
        }
      }
    }

    // Migrations are applied in filename order, so the last definition wins.
    const byName = new Map<string, DatabaseSchemaEntry>();
    for (const table of tables) {
      byName.set(table.name, table);
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: index.indexVersion,
      updatedAt: this.clock.now(),
      tables: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_DB_OBJECTS),
      migrations: migrations.slice(0, 200)
    };
  }
}

export function countLanguages(files: FileRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return counts;
}

function collectRoutes(files: FileRecord[]): ProjectOverview['apiRoutes'] {
  const routes: ProjectOverview['apiRoutes'] = [];
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.kind !== 'route') {
        continue;
      }
      routes.push({ name: symbol.name, detail: symbol.detail, path: file.path, line: symbol.line, confidence: symbol.confidence });
      if (routes.length >= MAX_ROUTES) {
        return routes;
      }
    }
  }
  return routes;
}

function isInstructionFile(path: string): boolean {
  const lower = path.toLowerCase();
  const name = baseName(lower);
  if (name === 'readme.md' || name === 'readme.markdown' || name === 'contributing.md' || name === 'agents.md' || name === 'claude.md') {
    return true;
  }
  if (name === 'copilot-instructions.md') {
    return true;
  }
  if (dirOf(lower) === '.github' && name.includes('copilot-instructions')) {
    return true;
  }
  if (extName(lower) === '.md' && /(^|\/)docs?\//.test(lower) && /(architecture|design|overview|structure)/.test(name)) {
    return true;
  }
  return lower === '.cursorrules';
}

/** Selected symbols used for the compact textual overview. */
export function notableSymbols(file: FileRecord, limit = 6): SymbolRecord[] {
  return file.symbols
    .filter((symbol) => symbol.kind !== 'column' && symbol.kind !== 'section')
    .sort((a, b) => symbolWeight(b.kind) - symbolWeight(a.kind) || a.line - b.line)
    .slice(0, limit);
}

function symbolWeight(kind: SymbolRecord['kind']): number {
  switch (kind) {
    case 'class':
    case 'table':
    case 'interface':
    case 'component':
      return 10;
    case 'function':
    case 'method':
    case 'route':
    case 'view':
      return 8;
    case 'trait':
    case 'enum':
    case 'type':
    case 'namespace':
      return 6;
    default:
      return 3;
  }
}

export function describeIndexErrors(errors: IndexError[]): string {
  if (errors.length === 0) {
    return 'no indexing errors';
  }
  return `${errors.length} error(s): ${errors[0].path} - ${errors[0].message}`;
}
