import { baseName } from '../../util/paths';
import { splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol } from '../parseTypes';

const PARSER_VERSION = 'text-2';

/**
 * Fallback parser for plain-text configuration: dependency lists
 * (`requirements.txt`), TOML/INI sections and similar. It never tries to
 * understand code, it only records structure that the project map can use.
 */
export class TextParser implements FileParser {
  readonly id = 'text';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const name = baseName(input.path).toLowerCase();
    const symbols: SymbolRecord[] = [];
    const facts: Record<string, unknown> = {};

    if (name.startsWith('requirements') && name.endsWith('.txt')) {
      const requirements = lines
        .map((line) => line.split('#')[0].trim())
        .filter((line) => line.length > 0 && !line.startsWith('-'))
        .map((line) => line.split(/[=<>!~[]/)[0].trim())
        .filter((line) => line.length > 0);
      facts.requirements = requirements;
      for (const [index, requirement] of requirements.entries()) {
        if (index >= 80) {
          break;
        }
        pushSymbol(symbols, { name: requirement, kind: 'variable', line: findLine(lines, requirement) }, 'heuristic');
      }
      return { language: input.language, kind: input.kind, symbols, imports: [], references: [], confidence: 'heuristic', facts };
    }

    const sections: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
      if (sectionMatch) {
        sections.push(sectionMatch[1]);
        pushSymbol(symbols, { name: sectionMatch[1], kind: 'section', line: i + 1, signature: trimSignature(lines[i]) }, 'heuristic');
        continue;
      }
      const keyValue = /^([A-Za-z_][\w.\-]*)\s*[:=]\s*(.*)$/.exec(line);
      if (keyValue && symbols.length < 80) {
        pushSymbol(symbols, { name: keyValue[1], kind: 'variable', line: i + 1, detail: trimSignature(keyValue[2]) }, 'heuristic');
      }
    }
    if (sections.length > 0) {
      facts.sections = sections;
    }

    return { language: input.language, kind: input.kind, symbols, imports: [], references: [], confidence: 'heuristic', facts };
  }
}

function findLine(lines: string[], needle: string): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) {
      return i + 1;
    }
  }
  return 1;
}
