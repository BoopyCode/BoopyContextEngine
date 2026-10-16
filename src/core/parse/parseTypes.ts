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

/**
 * Collects references, keeping only a few occurrences per name to bound index size.
 *
 * The reserved word filter must be language specific. A shared list makes PHP
 * methods named `delete`, `get`, `set` or `default` invisible, because those are
 * keywords in JavaScript but perfectly ordinary method names in PHP - impact
 * analysis then reports "no references" for code that clearly has callers.
 */
export class ReferenceCollector {
  private readonly map = new Map<string, ReferenceRecord[]>();
  private count = 0;

  constructor(private readonly reserved: ReadonlySet<string> = KEYWORDS) {}

  add(name: string, line: number, kind: ReferenceRecord['kind'], confidence: Confidence = 'heuristic'): void {
    if (typeof name !== 'string' || name.length < 2 || this.reserved.has(name)) {
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

/** Default reserved words: JavaScript/TypeScript, plus SQL-ish statement words. */
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

/**
 * Reserved words for PHP.
 *
 * Deliberately *not* included: `delete`, `get`, `set`, `default`, `with`, `of`,
 * `is`, `type`. Those are JavaScript keywords, but in PHP they are ordinary and
 * very common method names (`$this->payments->delete(...)`). Filtering them made
 * `bceImpact` report zero references for methods that do have callers.
 *
 * `array`, `list`, `print`, `echo`, `isset`, `match` and `declare` stay filtered
 * because they really do appear as `word(` language constructs in PHP source.
 */
export const PHP_KEYWORDS = new Set([
  'abstract',
  'and',
  'array',
  'as',
  'break',
  'callable',
  'case',
  'catch',
  'class',
  'clone',
  'const',
  'continue',
  'declare',
  'die',
  'do',
  'echo',
  'else',
  'elseif',
  'empty',
  'enddeclare',
  'endfor',
  'endforeach',
  'endif',
  'endswitch',
  'endwhile',
  'enum',
  'eval',
  'exit',
  'extends',
  'final',
  'finally',
  'fn',
  'for',
  'foreach',
  'function',
  'global',
  'goto',
  'if',
  'implements',
  'include',
  'include_once',
  'instanceof',
  'insteadof',
  'interface',
  'isset',
  'list',
  'match',
  'namespace',
  'new',
  'or',
  'parent',
  'print',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'require_once',
  'return',
  'self',
  'static',
  'switch',
  'throw',
  'trait',
  'try',
  'unset',
  'use',
  'var',
  'while',
  'xor',
  'yield'
]);

/**
 * Reserved words for Python.
 *
 * Same reasoning as {@link PHP_KEYWORDS}: `delete`, `get`, `set` and `default`
 * are not Python keywords and must stay searchable.
 */
export const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'print',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'False',
  'None',
  'True',
  'case',
  'match',
  'self'
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
