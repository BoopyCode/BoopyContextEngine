import { maskCode, splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol, ReferenceCollector } from '../parseTypes';

const PARSER_VERSION = 'sql-3';

const CREATE_TABLE_RE = /^\s*create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"[]?[\w.$]+[`"\]]?)\s*\(/i;
const CREATE_VIEW_RE = /^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([`"[]?[\w.$]+[`"\]]?)/i;
const CREATE_INDEX_RE = /^\s*create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([`"[]?[\w.$]+[`"\]]?)\s+on\s+([`"[]?[\w.$]+[`"\]]?)/i;
const CREATE_TYPE_RE = /^\s*create\s+type\s+([`"[]?[\w.$]+[`"\]]?)/i;
const CREATE_SCHEMA_RE = /^\s*create\s+schema\s+(?:if\s+not\s+exists\s+)?([`"[]?[\w.$]+[`"\]]?)/i;
const ALTER_TABLE_RE = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([`"[]?[\w.$]+[`"\]]?)/i;
const DROP_TABLE_RE = /^\s*drop\s+table\s+(?:if\s+exists\s+)?([`"[]?[\w.$]+[`"\]]?)/i;
const CONSTRAINT_RE = /^\s*(?:constraint\s+([\w"`[\].$]+)\s+)?(primary\s+key|foreign\s+key|unique|check|exclude|index|key)\b/i;
const REFERENCES_RE = /references\s+([`"[]?[\w.$]+[`"\]]?)\s*\(\s*([^)]+)\s*\)/i;

interface PendingTable {
  name: string;
  line: number;
  buffer: string[];
  depth: number;
  signature: string;
}

interface ForeignKey {
  from: string;
  fromColumn?: string;
  to: string;
  toColumn?: string;
}

/**
 * Heuristic SQL parser. It understands DDL (tables, columns, views, indexes,
 * types, schemas, ALTER/DROP) which is what the project map needs; DML is ignored
 * on purpose because it says nothing about the project structure.
 */
export class SqlParser implements FileParser {
  readonly id = 'sql';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const masked = maskCode(input.content, { lineComment: '--' });
    const maskedLines = masked.lines;
    const symbols: SymbolRecord[] = [];
    const references = new ReferenceCollector();
    const foreignKeys: ForeignKey[] = [];
    let pending: PendingTable | undefined;

    const addSymbol = (draft: Parameters<typeof pushSymbol>[1], confidence: 'exact' | 'heuristic' = 'heuristic'): void => {
      pushSymbol(symbols, draft, confidence);
    };

    const finishPendingTable = (): void => {
      if (!pending) {
        return;
      }
      const current = pending;
      pending = undefined;
      const body = current.buffer.join('\n');
      addSymbol({
        name: current.name,
        kind: 'table',
        line: current.line,
        signature: trimSignature(current.signature),
        endLine: current.line + current.buffer.length
      });
      const definitions = splitTopLevel(body);
      let columnCount = 0;
      for (const definition of definitions) {
        const text = definition.trim();
        if (text.length === 0) {
          continue;
        }
        const constraintMatch = CONSTRAINT_RE.exec(text);
        if (constraintMatch && !/^[\w"`[$\].]+\s+[\w(]/.test(text)) {
          const target = REFERENCES_RE.exec(text);
          if (target) {
            foreignKeys.push({ from: current.name, to: normalizeName(target[1]), toColumn: target[2].trim() });
          }
          addSymbol({
            name: constraintMatch[1] ? normalizeName(constraintMatch[1]) : `${current.name}_${constraintMatch[2].toLowerCase().replace(/\s+/g, '_')}`,
            kind: 'index',
            line: current.line,
            container: current.name,
            detail: constraintMatch[2].toUpperCase(),
            signature: trimSignature(text)
          });
          continue;
        }
        const columnMatch = /^([`"[]?[\w$]+[`"\]]?)\s+([A-Za-z][\w\s()]*?)(?:\s+(.*))?$/.exec(text);
        if (!columnMatch) {
          continue;
        }
        const columnName = normalizeName(columnMatch[1]);
        const columnType = columnMatch[2].trim().replace(/\s+/g, ' ');
        const constraints = (columnMatch[3] ?? '').trim();
        columnCount += 1;
        addSymbol({
          name: columnName,
          kind: 'column',
          line: current.line,
          container: current.name,
          detail: columnType,
          signature: trimSignature(text)
        });
        const reference = REFERENCES_RE.exec(text);
        if (reference) {
          foreignKeys.push({ from: current.name, fromColumn: columnName, to: normalizeName(reference[1]), toColumn: reference[2].trim() });
        }
        if (constraints.length > 0) {
          references.add(columnType, current.line, 'type');
        }
      }
      if (columnCount === 0) {
        references.add(current.name, current.line, 'member');
      }
    };

    for (let i = 0; i < maskedLines.length; i += 1) {
      const maskedLine = maskedLines[i];
      const originalLine = lines[i];

      if (pending) {
        const depthBefore = pending.depth;
        const lineDepth = countChar(maskedLine, '(') - countChar(maskedLine, ')');
        const closesHere = depthBefore + lineDepth <= 0;
        // The closing line may carry trailing text (`) ENGINE=InnoDB;`), so only
        // the part before the final `)` belongs to the table body.
        const closingIndex = closesHere ? maskedLine.lastIndexOf(')') : -1;
        pending.buffer.push(closingIndex >= 0 ? originalLine.slice(0, closingIndex) : originalLine);
        pending.depth = depthBefore + lineDepth;
        if (pending.depth <= 0) {
          finishPendingTable();
        }
        continue;
      }

      if (maskedLine.trim().length === 0) {
        continue;
      }

      const tableMatch = CREATE_TABLE_RE.exec(maskedLine);
      if (tableMatch) {
        const openIndex = maskedLine.indexOf('(');
        const lineDepth = countChar(maskedLine, '(') - countChar(maskedLine, ')');
        pending = {
          name: normalizeName(tableMatch[1]),
          line: i + 1,
          buffer: openIndex >= 0 ? [originalLine.slice(openIndex + 1)] : [],
          depth: lineDepth,
          signature: originalLine
        };
        if (pending.depth <= 0) {
          const lastClose = pending.buffer[0]?.lastIndexOf(')') ?? -1;
          if (lastClose >= 0 && pending.buffer[0]) {
            pending.buffer[0] = pending.buffer[0].slice(0, lastClose);
          }
          finishPendingTable();
        }
        continue;
      }

      const viewMatch = CREATE_VIEW_RE.exec(maskedLine);
      if (viewMatch) {
        addSymbol({ name: normalizeName(viewMatch[1]), kind: 'view', line: i + 1, signature: trimSignature(originalLine) });
        continue;
      }

      const indexMatch = CREATE_INDEX_RE.exec(maskedLine);
      if (indexMatch) {
        addSymbol({
          name: normalizeName(indexMatch[1]),
          kind: 'index',
          line: i + 1,
          container: normalizeName(indexMatch[2]),
          signature: trimSignature(originalLine)
        });
        references.add(normalizeName(indexMatch[2]), i + 1, 'member');
        continue;
      }

      const typeMatch = CREATE_TYPE_RE.exec(maskedLine);
      if (typeMatch) {
        addSymbol({ name: normalizeName(typeMatch[1]), kind: 'type', line: i + 1, signature: trimSignature(originalLine) });
        continue;
      }

      const schemaMatch = CREATE_SCHEMA_RE.exec(maskedLine);
      if (schemaMatch) {
        addSymbol({ name: normalizeName(schemaMatch[1]), kind: 'namespace', line: i + 1, signature: trimSignature(originalLine) });
        continue;
      }

      const alterMatch = ALTER_TABLE_RE.exec(maskedLine);
      if (alterMatch) {
        const name = normalizeName(alterMatch[1]);
        addSymbol({ name, kind: 'table', line: i + 1, detail: 'ALTER', signature: trimSignature(originalLine) });
        references.add(name, i + 1, 'member');
        const target = REFERENCES_RE.exec(originalLine);
        if (target) {
          foreignKeys.push({ from: name, to: normalizeName(target[1]), toColumn: target[2].trim() });
        }
        continue;
      }

      const dropMatch = DROP_TABLE_RE.exec(maskedLine);
      if (dropMatch) {
        addSymbol({ name: normalizeName(dropMatch[1]), kind: 'table', line: i + 1, detail: 'DROP', signature: trimSignature(originalLine) });
        continue;
      }
    }

    finishPendingTable();

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports: [],
      references: references.toArray(),
      confidence: 'heuristic',
      facts: {
        foreignKeys
      }
    };
  }
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
}

function normalizeName(value: string): string {
  return value.replace(/[`"[\]]/g, '').trim();
}

/** Splits a definition list on commas that are not inside parentheses. */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    if (char === ',' && depth <= 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}
