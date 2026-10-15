import { maskCode, splitLines, trimSignature } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol } from '../parseTypes';

const PARSER_VERSION = 'dockerfile-2';

/** Extracts build stages, base images and exposed ports from a Dockerfile. */
export class DockerfileParser implements FileParser {
  readonly id = 'dockerfile';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const masked = maskCode(input.content, { hashComments: true, lineComment: '#' });
    const symbols: SymbolRecord[] = [];
    const baseImages: string[] = [];
    const stages: string[] = [];
    const exposedPorts: string[] = [];
    const entryCommands: string[] = [];

    for (let i = 0; i < masked.lines.length; i += 1) {
      const maskedLine = masked.lines[i].trim();
      if (maskedLine.length === 0) {
        continue;
      }
      const from = /^from\s+(\S+)(?:\s+as\s+(\S+))?/i.exec(maskedLine);
      if (from) {
        baseImages.push(from[1]);
        const stageName = from[2] ?? from[1];
        stages.push(stageName);
        pushSymbol(symbols, { name: stageName, kind: 'variable', line: i + 1, detail: from[1], signature: trimSignature(lines[i]) }, 'heuristic');
        continue;
      }
      const expose = /^expose\s+(.+)$/i.exec(maskedLine);
      if (expose) {
        exposedPorts.push(...expose[1].trim().split(/\s+/));
        continue;
      }
      const entry = /^(entrypoint|cmd)\s+(.+)$/i.exec(maskedLine);
      if (entry) {
        entryCommands.push(trimSignature(entry[2]));
      }
    }

    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports: [],
      references: [],
      confidence: 'heuristic',
      facts: {
        baseImages,
        stages,
        exposedPorts,
        entryCommands
      }
    };
  }
}
