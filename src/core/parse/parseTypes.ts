import { Confidence, FileKind, ImportRecord, LanguageId, ReferenceRecord, SymbolRecord } from '../types';

export interface ParseInput {
  /** Workspace-relative POSIX path; parsers use it only for naming conventions. */
  path: string;
  content: string;
  language: LanguageId;
  kind: FileKind;
}

export interface ParseOutput {
  language: LanguageId;
  kind: FileKind;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  references: ReferenceRecord[];
  /** Structured facts used by the project map (dependency names, services, namespaces). */
  facts?: Record<string, unknown>;
  confidence: Confidence;
}

export interface FileParser {
  readonly id: string;
  /** Bumping this invalidates the layer 1 parse cache for the language. */
  readonly version: string;
  parse(input: ParseInput): ParseOutput;
}

export const MAX_SYMBOLS_PER_FILE = 400;
export const MAX_REFERENCES_PER_NAME = 3;
export const MAX_REFERENCES_PER_FILE = 3000;

/** Collects references, keeping only a few occurrences per name to bound index size. */
export class ReferenceCollector {
  private readonly map = new Map<string, ReferenceRecord[]>();
  private count = 0;

  add(name: string, line: number, kind: ReferenceRecord['kind'], confidence: Confidence = 'heuristic'): void {
    if (typeof name !== 'string' || name.length < 2 || KEYWORDS.has(name)) {
      return;
    }
    if (this.count >= MAX_REFERENCES_PER_FILE) {
      return;
    }
    const existing = this.map.get(name);
    if (existing) {
      if (existing.length >= MAX_REFERENCES_PER_NAME) {
        return;
      }
      if (existing.some((record) => record.line === line && record.kind === kind)) {
        return;
      }
      existing.push({ name, line, kind, confidence });
    } else {
      this.map.set(name, [{ name, line, kind, confidence }]);
    }
    this.count += 1;
  }

  toArray(): ReferenceRecord[] {
    const out: ReferenceRecord[] = [];
    for (const records of this.map.values()) {
      out.push(...records);
    }
    return out.sort((a, b) => a.line - b.line);
  }
}

export const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'instanceof',
  'await',
  'new',
  'super',
  'this',
  'else',
  'do',
  'try',
  'finally',
  'case',
  'delete',
  'void',
  'yield',
  'in',
  'of',
  'as',
  'is',
  'throw',
  'import',
  'export',
  'default',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'const',
  'let',
  'var',
  'namespace',
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'abstract',
  'async',
  'override',
  'get',
  'set',
  'with',
  'assert',
  'sizeof',
  'isset',
  'unset',
  'empty',
  'echo',
  'print',
  'require',
  'require_once',
  'include',
  'include_once',
  'use',
  'and',
  'or',
  'xor',
  'array',
  'list',
  'match',
  'endswitch',
  'endwhile',
  'endforeach',
  'self',
  'parent',
  'nan',
  'int',
  'str',
  'len',
  'dict',
  'set',
  'tuple',
  'None',
  'True',
  'False',
  'def',
  'lambda',
  'pass',
  'raise',
  'global',
  'nonlocal',
  'assert',
  'print',
  'super',
  'select',
  'where',
  'from'
]);

export interface SymbolDraft {
  name: string;
  kind: SymbolRecord['kind'];
  line: number;
  endLine?: number;
  exported?: boolean;
  container?: string;
  signature?: string;
  doc?: string;
  detail?: string;
}

export function pushSymbol(symbols: SymbolRecord[], draft: SymbolDraft, confidence: Confidence): boolean {
  if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
    return false;
  }
  // Defensive: a parser bug must never put an unnamed symbol into the index,
  // because downstream code assumes names are strings.
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) {
    return false;
  }
  symbols.push({ ...draft, confidence });
  return true;
}
