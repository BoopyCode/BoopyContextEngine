import { baseName, splitIdentifier } from '../../util/paths';
import { maskCode, splitLines } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol } from '../parseTypes';

const PARSER_VERSION = 'yaml-2';
const MAX_TOP_LEVEL_SYMBOLS = 60;

/**
 * Minimal YAML scanner for the configuration files that carry structural meaning:
 * docker-compose services, CI workflow jobs and their trigger events, plus the top
 * level keys. It is intentionally not a full YAML parser.
 */
export class YamlParser implements FileParser {
  readonly id = 'yaml';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const symbols: SymbolRecord[] = [];
    const composeServices: string[] = [];
    const workflowJobs: string[] = [];
    const triggers: string[] = [];
    const topLevelKeys: string[] = [];
    const fileName = baseName(input.path).toLowerCase();

    let section: 'none' | 'services' | 'jobs' | 'on' = 'none';
    let sectionIndent = -1;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const withoutComment = maskCode(raw, { hashComments: true, lineComment: '#' }).lines[0];
      if (withoutComment.trim().length === 0 || raw.trim().startsWith('---')) {
        continue;
      }
      const indent = withoutComment.length - withoutComment.trimStart().length;
      const keyMatch = /^([A-Za-z0-9_.\-"']+)\s*:/.exec(withoutComment.trim());

      if (indent === 0) {
        section = 'none';
        sectionIndent = -1;
        if (!keyMatch) {
          continue;
        }
        const key = keyMatch[1].replace(/^["']|["']$/g, '');
        if (topLevelKeys.length < MAX_TOP_LEVEL_SYMBOLS) {
          topLevelKeys.push(key);
          pushSymbol(symbols, { name: key, kind: 'variable', line: i + 1 }, 'heuristic');
        }
        if (key === 'services') {
          section = 'services';
          sectionIndent = indent;
        } else if (key === 'jobs') {
          section = 'jobs';
          sectionIndent = indent;
        } else if (key === 'on' || key === 'true') {
          section = 'on';
          sectionIndent = indent;
        }
        continue;
      }

      if (section === 'none' || !keyMatch) {
        continue;
      }

      const key = keyMatch[1].replace(/^["']|["']$/g, '');
      if (section === 'services' && indent > sectionIndent && indent <= sectionIndent + 2) {
        composeServices.push(key);
        pushSymbol(symbols, { name: key, kind: 'variable', line: i + 1, container: 'services' }, 'heuristic');
      } else if (section === 'jobs' && indent > sectionIndent && indent <= sectionIndent + 2) {
        workflowJobs.push(key);
        pushSymbol(symbols, { name: key, kind: 'variable', line: i + 1, container: 'jobs' }, 'heuristic');
      } else if (section === 'on' && indent > sectionIndent && indent <= sectionIndent + 2) {
        triggers.push(key);
      }
    }

    const isCompose = /(?:^|-)compose\.ya?ml$/.test(fileName) || composeServices.length > 0;
    const isWorkflow = input.path.toLowerCase().includes('.github/workflows/');

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports: [],
      references: [],
      confidence: 'heuristic',
      facts: {
        composeServices: composeServices.length > 0 ? composeServices : undefined,
        workflowJobs: workflowJobs.length > 0 ? workflowJobs : undefined,
        workflowTriggers: triggers.length > 0 ? triggers : undefined,
        isCompose,
        isWorkflow
      }
    };
  }
}

/** Detects a docker-compose file from its path alone (used for framework detection). */
export function isComposeFile(path: string): boolean {
  const name = baseName(path).toLowerCase();
  return name === 'docker-compose.yml' || name === 'docker-compose.yaml' || name === 'compose.yml' || name === 'compose.yaml';
}

/** Detects a CI workflow file. */
export function isWorkflowFile(path: string): boolean {
  return path.toLowerCase().startsWith('.github/workflows/');
}

export function describeComposeService(name: string): string[] {
  return splitIdentifier(name);
}
