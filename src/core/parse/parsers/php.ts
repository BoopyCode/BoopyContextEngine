import { braceDepths, docCommentAbove, findBlockEnd, maskCode, splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, PHP_KEYWORDS, pushSymbol, ReferenceCollector } from '../parseTypes';

const PARSER_VERSION = 'php-3';

interface Container {
  name: string;
  kind: 'class' | 'interface' | 'trait' | 'enum';
  /** Brace depth inside the body, or -1 while the opening brace has not been seen. */
  bodyDepth: number;
}

const NAMESPACE_RE = /^\s*namespace\s+([\w\\]+)\s*;/;
const USE_RE = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/;
const CLASS_RE = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/;
const FUNCTION_RE = /^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/;
const PROPERTY_RE = /^\s*(?:(?:public|private|protected|static|readonly|var)\s+)+(?:[?\w\\|\[\]]+\s+)?\$([A-Za-z_]\w*)/;
const CONST_RE = /^\s*(?:(?:public|private|protected|final)\s+)*const\s+([A-Za-z_]\w*)/;
const LARAVEL_ROUTE_RE = /Route::(get|post|put|patch|delete|any|options|resource)\s*\(\s*['"]([^'"]*)['"]/;
const METHOD_ROUTE_RE = /->(get|post|put|patch|delete)\s*\(\s*['"]([^'"]*)['"]/;
const SCHEMA_CREATE_RE = /Schema::create\s*\(\s*['"]([^'"]+)['"]/;
const SCHEMA_TABLE_RE = /Schema::table\s*\(\s*['"]([^'"]+)['"]/;
const COLUMN_RE = /\$table->(\w+)\s*\(\s*['"]([^'"]+)['"]/;
const INCLUDE_RE = /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
const NEW_RE = /\bnew\s+([A-Za-z_]\w*)/g;
const STATIC_CALL_RE = /\b([A-Za-z_]\w*)::\w+/g;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const RETURN_TYPE_RE = /\)\s*:\s*\??([A-Za-z_]\w*)/g;

/**
 * Heuristic PHP parser (Laravel/Symfony/plain PHP): namespaces, `use` imports,
 * classes/traits/interfaces/enums, methods, properties, constants, routes and
 * Laravel schema builder statements.
 */
export class PhpParser implements FileParser {
  readonly id = 'php';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const masked = maskCode(input.content, { hashComments: true, lineComment: '//' });
    const maskedLines = masked.lines;
    const depths = braceDepths(maskedLines);
    const symbols: SymbolRecord[] = [];
    const imports: ParseOutput['imports'] = [];
    const references = new ReferenceCollector(PHP_KEYWORDS);
    const containers: Container[] = [];
    let namespace: string | undefined;
    let usesLaravel = false;
    let usesSchemaBuilder = false;
    const schemaTables = new Map<string, string>();

    const addSymbol = (draft: Parameters<typeof pushSymbol>[1]): void => {
      pushSymbol(symbols, draft, 'heuristic');
    };

    for (let i = 0; i < maskedLines.length; i += 1) {
      const maskedLine = maskedLines[i];
      const originalLine = lines[i];
      const depth = depths[i];

      while (containers.length > 0) {
        const top = containers[containers.length - 1];
        if (top.bodyDepth === -1 || depth >= top.bodyDepth) {
          break;
        }
        containers.pop();
      }
      // PHP puts the class opening brace on its own line.
      for (const container of containers) {
        if (container.bodyDepth === -1 && maskedLine.includes('{')) {
          container.bodyDepth = depth + 1;
        }
      }

      if (maskedLine.trim().length === 0) {
        continue;
      }

      const namespaceMatch = NAMESPACE_RE.exec(maskedLine);
      if (namespaceMatch) {
        namespace = namespaceMatch[1];
        continue;
      }

      const useMatch = USE_RE.exec(maskedLine);
      if (useMatch) {
        const specifier = useMatch[1];
        imports.push({ specifier, line: i + 1, confidence: 'exact' });
        if (/Laravel|Illuminate/i.test(specifier)) {
          usesLaravel = true;
        }
        references.add(specifier.split('\\').pop() as string, i + 1, 'type');
        continue;
      }

      const classMatch = CLASS_RE.exec(maskedLine);
      if (classMatch) {
        const name = classMatch[2];
        addSymbol({
          name,
          kind: classMatch[1] === 'interface' ? 'interface' : classMatch[1] === 'trait' ? 'trait' : classMatch[1] === 'enum' ? 'enum' : 'class',
          line: i + 1,
          endLine: findBlockEnd(maskedLines, i),
          signature: trimSignature(originalLine),
          doc: docCommentAbove(lines, i),
          detail: namespace
        });
        containers.push({ name, kind: classMatch[1] as Container['kind'], bodyDepth: maskedLine.includes('{') ? depth + 1 : -1 });
        for (const match of maskedLine.matchAll(/(?:extends|implements)\s+([A-Za-z_]\w*)/g)) {
          references.add(match[1], i + 1, 'type');
        }
        continue;
      }

      const schemaCreate = SCHEMA_CREATE_RE.exec(originalLine);
      if (schemaCreate) {
        usesSchemaBuilder = true;
        usesLaravel = true;
        schemaTables.set('__current__', schemaCreate[1]);
        addSymbol({ name: schemaCreate[1], kind: 'table', line: i + 1, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
        continue;
      }

      const schemaTable = SCHEMA_TABLE_RE.exec(originalLine);
      if (schemaTable) {
        usesSchemaBuilder = true;
        schemaTables.set('__current__', schemaTable[1]);
        continue;
      }

      const currentTable = schemaTables.get('__current__');
      if (currentTable) {
        const columnMatch = COLUMN_RE.exec(originalLine);
        if (columnMatch) {
          addSymbol({
            name: columnMatch[2],
            kind: 'column',
            line: i + 1,
            container: currentTable,
            detail: columnMatch[1],
            signature: trimSignature(originalLine)
          });
          continue;
        }
      }

      const functionMatch = FUNCTION_RE.exec(maskedLine);
      if (functionMatch) {
        const container = containers.length > 0 ? containers[containers.length - 1].name : undefined;
        addSymbol({
          name: functionMatch[1],
          kind: container ? 'method' : 'function',
          line: i + 1,
          endLine: findBlockEnd(maskedLines, i),
          container,
          signature: trimSignature(originalLine),
          doc: docCommentAbove(lines, i)
        });
        for (const match of maskedLine.matchAll(RETURN_TYPE_RE)) {
          references.add(match[1], i + 1, 'type');
        }
        continue;
      }

      const constMatch = CONST_RE.exec(maskedLine);
      if (constMatch) {
        addSymbol({
          name: constMatch[1],
          kind: 'const',
          line: i + 1,
          container: containers.length > 0 ? containers[containers.length - 1].name : undefined,
          signature: trimSignature(originalLine)
        });
        continue;
      }

      const propertyMatch = PROPERTY_RE.exec(maskedLine);
      if (propertyMatch && containers.length > 0) {
        addSymbol({
          name: propertyMatch[1],
          kind: 'variable',
          line: i + 1,
          container: containers[containers.length - 1].name,
          signature: trimSignature(originalLine)
        });
        continue;
      }

      const routeMatch = LARAVEL_ROUTE_RE.exec(originalLine);
      if (routeMatch) {
        usesLaravel = true;
        addSymbol({
          name: routeMatch[2] === '' ? '/' : routeMatch[2],
          kind: 'route',
          line: i + 1,
          detail: routeMatch[1].toUpperCase(),
          signature: trimSignature(originalLine)
        });
      } else {
        const methodRoute = METHOD_ROUTE_RE.exec(originalLine);
        if (methodRoute) {
          addSymbol({
            name: methodRoute[2] === '' ? '/' : methodRoute[2],
            kind: 'route',
            line: i + 1,
            detail: methodRoute[1].toUpperCase(),
            signature: trimSignature(originalLine)
          });
        }
      }

      for (const match of maskedLine.matchAll(NEW_RE)) {
        references.add(match[1], i + 1, 'new');
      }
      for (const match of maskedLine.matchAll(STATIC_CALL_RE)) {
        references.add(match[1], i + 1, 'call');
      }
      for (const match of maskedLine.matchAll(CALL_RE)) {
        references.add(match[1], i + 1, 'call');
      }
      for (const match of originalLine.matchAll(INCLUDE_RE)) {
        imports.push({ specifier: match[1], line: i + 1, confidence: 'exact' });
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
        namespace,
        laravel: usesLaravel,
        schemaBuilder: usesSchemaBuilder
      }
    };
  }
}
