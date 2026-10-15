import { docCommentAbove, findIndentBlockEnd, maskCode, splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol, ReferenceCollector } from '../parseTypes';

const PARSER_VERSION = 'python-3';

const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const IMPORT_RE = /^\s*import\s+([\w.]+)/;
const FROM_IMPORT_RE = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;
const DJANGO_FIELD_RE = /^\s{4,}([A-Za-z_]\w*)\s*=\s*models\.(\w+)\s*\(/;
const FLASK_ROUTE_RE = /^\s*@(\w+)\.(route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]*)['"]/;
const DJANGO_PATH_RE = /^\s*(?:path|re_path|url)\s*\(\s*['"]([^'"]*)['"]/;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const DECORATOR_RE = /^\s*@([A-Za-z_][\w.]*)/;

/**
 * Heuristic Python parser: classes, functions/methods (by indentation), imports,
 * Flask/FastAPI route decorators, Django `path()` entries and Django model fields.
 */
export class PythonParser implements FileParser {
  readonly id = 'python';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const masked = maskCode(input.content, { hashComments: true, lineComment: '#' });
    const maskedLines = masked.lines;
    const symbols: SymbolRecord[] = [];
    const imports: ParseOutput['imports'] = [];
    const references = new ReferenceCollector();
    const classStack: { name: string; indent: number }[] = [];
    let djangoModels = false;
    let flaskOrFastApi = false;
    let djangoUrls = false;

    const addSymbol = (draft: Parameters<typeof pushSymbol>[1]): void => {
      pushSymbol(symbols, draft, 'heuristic');
    };

    for (let i = 0; i < maskedLines.length; i += 1) {
      const maskedLine = maskedLines[i];
      const originalLine = lines[i];
      if (maskedLine.trim().length === 0) {
        continue;
      }
      const indent = maskedLine.length - maskedLine.trimStart().length;
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
        classStack.pop();
      }

      const importMatch = IMPORT_RE.exec(maskedLine);
      if (importMatch) {
        imports.push({ specifier: importMatch[1], line: i + 1, confidence: 'exact' });
      }
      const fromImport = FROM_IMPORT_RE.exec(maskedLine);
      if (fromImport) {
        imports.push({ specifier: fromImport[1], line: i + 1, confidence: 'exact' });
      }

      const classMatch = CLASS_RE.exec(maskedLine);
      if (classMatch) {
        const name = classMatch[2];
        const bases = classMatch[3] ?? '';
        const isModel = /(?:^|\.)Model$/.test(bases.trim());
        if (isModel) {
          djangoModels = true;
        }
        addSymbol({
          name,
          kind: 'class',
          line: i + 1,
          endLine: findIndentBlockEnd(lines, i),
          signature: trimSignature(originalLine),
          doc: docCommentAbove(lines, i),
          detail: bases.trim() || undefined
        });
        classStack.push({ name, indent });
        continue;
      }

      const defMatch = DEF_RE.exec(maskedLine);
      if (defMatch) {
        const container = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;
        addSymbol({
          name: defMatch[2],
          kind: container ? 'method' : 'function',
          line: i + 1,
          endLine: findIndentBlockEnd(lines, i),
          container,
          signature: trimSignature(originalLine),
          doc: docCommentAbove(lines, i)
        });
        for (const match of maskedLine.matchAll(CALL_RE)) {
          references.add(match[1], i + 1, 'call');
        }
        continue;
      }

      const modelField = DJANGO_FIELD_RE.exec(originalLine);
      if (modelField && djangoModels && classStack.length > 0) {
        addSymbol({
          name: modelField[1],
          kind: 'column',
          line: i + 1,
          container: classStack[classStack.length - 1].name,
          detail: modelField[2],
          signature: trimSignature(originalLine)
        });
        continue;
      }

      const flaskRoute = FLASK_ROUTE_RE.exec(originalLine);
      if (flaskRoute) {
        flaskOrFastApi = true;
        addSymbol({
          name: flaskRoute[3] === '' ? '/' : flaskRoute[3],
          kind: 'route',
          line: i + 1,
          detail: flaskRoute[2].toUpperCase(),
          signature: trimSignature(originalLine)
        });
      } else {
        const djangoPath = DJANGO_PATH_RE.exec(originalLine);
        if (djangoPath) {
          djangoUrls = true;
          addSymbol({ name: djangoPath[1] === '' ? '/' : djangoPath[1], kind: 'route', line: i + 1, signature: trimSignature(originalLine) });
        }
      }

      const decorator = DECORATOR_RE.exec(maskedLine);
      if (decorator) {
        const parts = decorator[1].split('.');
        references.add(parts[parts.length - 1], i + 1, 'call');
      }

      for (const match of maskedLine.matchAll(CALL_RE)) {
        references.add(match[1], i + 1, 'call');
      }
    }

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports,
      references: references.toArray(),
      confidence: 'heuristic',
      facts: {
        djangoModels,
        djangoUrls,
        flaskOrFastApi
      }
    };
  }
}
