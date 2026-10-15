import { baseName } from '../../util/paths';
import { splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol } from '../parseTypes';

const PARSER_VERSION = 'json-2';
const MAX_TOP_LEVEL_SYMBOLS = 60;

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

/**
 * JSON parser. Beyond the top level keys it extracts the dependency and entry
 * point facts that the project map uses for framework detection, so the map can be
 * built without re-reading file contents.
 */
export class JsonParser implements FileParser {
  readonly id = 'json';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const symbols: SymbolRecord[] = [];
    const facts: Record<string, unknown> = {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(input.content));
    } catch (error) {
      return {
        language: input.language,
        kind: input.kind,
        symbols,
        imports: [],
        references: [],
        confidence: 'heuristic',
        facts: { parseError: error instanceof Error ? error.message : 'invalid JSON' }
      };
    }

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      let index = 0;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (index < MAX_TOP_LEVEL_SYMBOLS) {
          pushSymbol(
            symbols,
            {
              name: key,
              kind: 'variable',
              line: findKeyLine(input.content, key),
              detail: previewOf(value)
            },
            'heuristic'
          );
        }
        index += 1;
      }
    }

    const fileName = baseName(input.path).toLowerCase();
    if (fileName === 'package.json') {
      facts.packageJson = readPackageJson(parsed);
    } else if (fileName === 'composer.json') {
      facts.composer = readComposer(parsed);
    } else if (fileName.startsWith('tsconfig')) {
      facts.tsconfig = readTsConfig(parsed);
    }

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports: [],
      references: [],
      confidence: 'heuristic',
      facts
    };
  }
}

function readPackageJson(parsed: unknown): PackageJsonFacts {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const bin = root.bin;
  return {
    name: typeof root.name === 'string' ? root.name : undefined,
    dependencies: keysOf(root.dependencies),
    devDependencies: keysOf(root.devDependencies),
    scripts: keysOf(root.scripts),
    main: typeof root.main === 'string' ? root.main : undefined,
    bin: valuesOf(bin),
    workspaces: Array.isArray(root.workspaces) ? root.workspaces.filter((item): item is string => typeof item === 'string') : keysOf(root.workspaces)
  };
}

function readComposer(parsed: unknown): ComposerFacts {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const autoload = (root.autoload ?? {}) as Record<string, unknown>;
  const bin = root.bin;
  return {
    name: typeof root.name === 'string' ? root.name : undefined,
    require: keysOf(root.require),
    requireDev: keysOf(root['require-dev']),
    autoloadNamespaces: Object.keys((autoload['psr-4'] as Record<string, unknown>) ?? {}),
    bin: typeof bin === 'string' ? [bin] : Array.isArray(bin) ? bin.filter((item): item is string => typeof item === 'string') : []
  };
}

function readTsConfig(parsed: unknown): Record<string, unknown> {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const compilerOptions = (root.compilerOptions ?? {}) as Record<string, unknown>;
  return {
    extends: root.extends,
    strict: compilerOptions.strict,
    paths: Object.keys((compilerOptions.paths as Record<string, unknown>) ?? {})
  };
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** `bin` maps command names to file paths; BCE needs the paths. */
function valuesOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function previewOf(value: unknown): string | undefined {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `object(${keys.slice(0, 4).join(',')})` : 'object';
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function findKeyLine(content: string, key: string): number {
  const lines = splitLines(content);
  const needle = `"${key}"`;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith(needle) && lines[i].includes(':')) {
      return i + 1;
    }
  }
  return 1;
}

function stripJsonComments(content: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Kept for symmetry with other parsers: JSON has no signature concept. */
export function jsonSymbolSignature(symbol: SymbolRecord): string {
  return trimSignature(`${symbol.name}: ${symbol.detail ?? 'value'}`);
}
