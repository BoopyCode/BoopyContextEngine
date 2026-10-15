import { braceDepths, docCommentAbove, findBlockEnd, maskCode, splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol, ReferenceCollector, SymbolDraft } from '../parseTypes';

const PARSER_VERSION = 'tsjs-4';

interface Container {
  name: string;
  kind: 'class' | 'namespace' | 'interface';
  /** Brace depth inside the body, or -1 while the opening brace has not been seen. */
  bodyDepth: number;
}

const CLASS_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const INTERFACE_RE = /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TYPE_RE = /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/;
const ENUM_RE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const NAMESPACE_RE = /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/;
const FUNCTION_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const ARROW_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|<[^>]*>\s*\()/;
const CLASS_METHOD_RE =
  /^\s*(?:(?:public|private|protected|static|readonly|abstract|async|override|declare|get|set|\*)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const CLASS_PROPERTY_ARROW_RE =
  /^\s*(?:(?:public|private|protected|static|readonly|declare)\s+)*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(/;
const MEMBER_MODIFIER_RE = /^\s*(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set)\b/;

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/;
const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/;

const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const NEW_RE = /\bnew\s+([A-Za-z_$][\w$]*)/g;
const TYPE_ANNOTATION_RE = /:\s*([A-Z][\w$]*)/g;
const EXTENDS_RE = /\b(?:extends|implements)\s+([A-Za-z_$][\w$]*)/g;
const JSX_RE = /<([A-Z][\w$]*)[\s/>]/g;
const DECORATOR_RE = /^\s*@([A-Za-z_$][\w$]*)\s*\(/;
const ROUTE_CALL_RE =
  /\b(?:app|router|server|fastify|route|api)\s*\.\s*(get|post|put|patch|delete|options|head|all|use)\s*\(\s*['"]([^'"]*)['"]/;
const NEST_ROUTE_RE = /^\s*@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*['"]([^'"]*)['"]/;

const CONTROL_KEYWORDS = /^(if|for|while|switch|catch|return|do|else|with|super|this|new|typeof|await|delete|void|function|class)$/;

/**
 * Heuristic TypeScript/JavaScript parser.
 *
 * It is deliberately not a full AST parser: it masks strings/comments, tracks brace
 * depth to know the enclosing container and reports every symbol with `heuristic`
 * confidence so no consumer mistakes it for compiler-grade data.
 */
export class TsJsParser implements FileParser {
  readonly id = 'tsjs';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const masked = maskCode(input.content, { lineComment: '//' });
    const maskedLines = masked.lines;
    const depths = braceDepths(maskedLines);
    const symbols: SymbolRecord[] = [];
    const imports: ParseOutput['imports'] = [];
    const references = new ReferenceCollector();
    const containers: Container[] = [];
    const isNextRouteFile = /\/route\.[cm]?[jt]sx?$/.test(input.path);

    const addSymbol = (draft: SymbolDraft): void => {
      pushSymbol(symbols, draft, 'heuristic');
    };

    for (let i = 0; i < maskedLines.length; i += 1) {
      const maskedLine = maskedLines[i];
      const originalLine = lines[i];
      const depth = depths[i];

      while (containers.length > 0) {
        const top = containers[containers.length - 1];
        if (top.bodyDepth === -1) {
          break;
        }
        if (depth >= top.bodyDepth) {
          break;
        }
        containers.pop();
      }
      // Allman style declarations put the opening brace on the next line.
      for (const container of containers) {
        if (container.bodyDepth === -1 && maskedLine.includes('{')) {
          container.bodyDepth = depth + 1;
        }
      }

      if (maskedLine.trim().length === 0) {
        continue;
      }

      const exported = /^\s*export\b/.test(maskedLine);
      const top = containers.length > 0 ? containers[containers.length - 1] : undefined;
      const container = top?.name;
      const insideClassBody = top?.kind === 'class' && top.bodyDepth !== -1 && depth === top.bodyDepth;

      if (!insideClassBody) {
        const classMatch = CLASS_RE.exec(maskedLine);
        if (classMatch) {
          addSymbol({ name: classMatch[1], kind: 'class', line: i + 1, exported, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
          containers.push({ name: classMatch[1], kind: 'class', bodyDepth: maskedLine.includes('{') ? depth + 1 : -1 });
          collectReferences(maskedLine, i + 1, references);
          continue;
        }

        const interfaceMatch = INTERFACE_RE.exec(maskedLine);
        if (interfaceMatch) {
          addSymbol({ name: interfaceMatch[1], kind: 'interface', line: i + 1, exported, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
          containers.push({ name: interfaceMatch[1], kind: 'interface', bodyDepth: maskedLine.includes('{') ? depth + 1 : -1 });
          collectReferences(maskedLine, i + 1, references);
          continue;
        }

        const namespaceMatch = NAMESPACE_RE.exec(maskedLine);
        if (namespaceMatch) {
          addSymbol({ name: namespaceMatch[1], kind: 'namespace', line: i + 1, exported, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
          containers.push({ name: namespaceMatch[1], kind: 'namespace', bodyDepth: maskedLine.includes('{') ? depth + 1 : -1 });
          continue;
        }

        const enumMatch = ENUM_RE.exec(maskedLine);
        if (enumMatch) {
          addSymbol({ name: enumMatch[1], kind: 'enum', line: i + 1, exported, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
          continue;
        }

        const typeMatch = TYPE_RE.exec(maskedLine);
        if (typeMatch) {
          addSymbol({ name: typeMatch[1], kind: 'type', line: i + 1, exported, signature: trimSignature(originalLine), doc: docCommentAbove(lines, i) });
          continue;
        }

        const functionMatch = FUNCTION_RE.exec(maskedLine);
        if (functionMatch) {
          addSymbol({
            name: functionMatch[1],
            kind: container ? 'method' : 'function',
            line: i + 1,
            endLine: findBlockEnd(maskedLines, i),
            exported,
            container,
            signature: trimSignature(originalLine),
            doc: docCommentAbove(lines, i)
          });
          collectReferences(maskedLine, i + 1, references);
          continue;
        }

        const arrowMatch = ARROW_RE.exec(maskedLine);
        if (arrowMatch) {
          addSymbol({
            name: arrowMatch[1],
            kind: looksLikeComponent(lines, i) ? 'component' : 'const',
            line: i + 1,
            endLine: findBlockEnd(maskedLines, i, 80),
            exported,
            container,
            signature: trimSignature(originalLine),
            doc: docCommentAbove(lines, i)
          });
          collectReferences(maskedLine, i + 1, references);
          continue;
        }
      } else {
        const methodMatch = CLASS_METHOD_RE.exec(maskedLine);
        if (methodMatch && !CONTROL_KEYWORDS.test(methodMatch[1]) && hasMethodShape(maskedLine, originalLine)) {
          addSymbol({
            name: methodMatch[1],
            kind: 'method',
            line: i + 1,
            endLine: findBlockEnd(maskedLines, i),
            container,
            signature: trimSignature(originalLine),
            doc: docCommentAbove(lines, i)
          });
          collectReferences(maskedLine, i + 1, references);
          continue;
        }
        const propertyMatch = CLASS_PROPERTY_ARROW_RE.exec(maskedLine);
        if (propertyMatch) {
          addSymbol({
            name: propertyMatch[1],
            kind: 'const',
            line: i + 1,
            endLine: findBlockEnd(maskedLines, i, 80),
            container,
            signature: trimSignature(originalLine),
            doc: docCommentAbove(lines, i)
          });
          continue;
        }
      }

      const routeMatch = ROUTE_CALL_RE.exec(originalLine);
      if (routeMatch) {
        addSymbol({
          name: routeMatch[2] === '' ? '/' : routeMatch[2],
          kind: 'route',
          line: i + 1,
          detail: routeMatch[1].toUpperCase(),
          signature: trimSignature(originalLine)
        });
      } else {
        const nestRoute = NEST_ROUTE_RE.exec(originalLine);
        if (nestRoute) {
          addSymbol({
            name: nestRoute[2] === '' ? '/' : nestRoute[2],
            kind: 'route',
            line: i + 1,
            detail: nestRoute[1].toUpperCase(),
            signature: trimSignature(originalLine)
          });
        } else if (isNextRouteFile) {
          const nextRoute = /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(maskedLine);
          if (nextRoute) {
            addSymbol({ name: input.path, kind: 'route', line: i + 1, detail: nextRoute[1], signature: trimSignature(originalLine) });
          }
        }
      }

      collectReferences(maskedLine, i + 1, references);
    }

    collectImports(lines, maskedLines, imports);

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports,
      references: references.toArray(),
      confidence: 'heuristic',
      facts: {
        hasReactComponents: symbols.some((symbol) => symbol.kind === 'component')
      }
    };
  }
}

function looksLikeComponent(lines: string[], startIndex: number): boolean {
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 15); i += 1) {
    if (/return\s*\(?\s*</.test(lines[i])) {
      return true;
    }
  }
  return false;
}

function hasMethodShape(maskedLine: string, originalLine: string): boolean {
  if (MEMBER_MODIFIER_RE.test(maskedLine)) {
    return true;
  }
  const trimmed = maskedLine.trim();
  const openIndex = trimmed.indexOf('(');
  if (openIndex <= 0) {
    return false;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed.slice(0, openIndex))) {
    return false;
  }
  const closeIndex = maskedLine.lastIndexOf(')');
  const after = closeIndex === -1 ? '' : maskedLine.slice(closeIndex + 1);
  if (after.includes('{') || after.includes(':') || after.trim() === '') {
    return true;
  }
  return /\)\s*\{?\s*$/.test(originalLine.split('//')[0].trim());
}

function collectReferences(maskedLine: string, line: number, references: ReferenceCollector): void {
  for (const match of maskedLine.matchAll(CALL_RE)) {
    references.add(match[1], line, 'call');
  }
  for (const match of maskedLine.matchAll(NEW_RE)) {
    references.add(match[1], line, 'new');
  }
  for (const match of maskedLine.matchAll(TYPE_ANNOTATION_RE)) {
    references.add(match[1], line, 'type');
  }
  for (const match of maskedLine.matchAll(EXTENDS_RE)) {
    references.add(match[1], line, 'type');
  }
  for (const match of maskedLine.matchAll(JSX_RE)) {
    references.add(match[1], line, 'call');
  }
  const decorator = DECORATOR_RE.exec(maskedLine);
  if (decorator) {
    references.add(decorator[1], line, 'call');
  }
}

function collectImports(lines: string[], maskedLines: string[], imports: ParseOutput['imports']): void {
  for (let i = 0; i < lines.length; i += 1) {
    const maskedLine = maskedLines[i];
    const originalLine = lines[i];
    if (!/\b(?:import|require|export)\b/.test(maskedLine)) {
      continue;
    }
    const direct = IMPORT_RE.exec(originalLine) ?? EXPORT_FROM_RE.exec(originalLine);
    if (direct) {
      imports.push({ specifier: direct[1], line: i + 1, confidence: 'exact' });
    }
    const requireRe = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of originalLine.matchAll(requireRe)) {
      if (!imports.some((entry) => entry.specifier === match[1] && entry.line === i + 1)) {
        imports.push({ specifier: match[1], line: i + 1, confidence: 'exact' });
      }
    }
  }
}
