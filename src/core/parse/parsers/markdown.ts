import { splitLines } from '../../util/text';
import { SymbolRecord } from '../../types';
import { FileParser, ParseInput, ParseOutput, pushSymbol } from '../parseTypes';

const PARSER_VERSION = 'markdown-2';
const MAX_HEADINGS = 80;

/** Extracts headings and code fences. Headings are exact, everything else is derived. */
export class MarkdownParser implements FileParser {
  readonly id = 'markdown';
  readonly version = PARSER_VERSION;

  parse(input: ParseInput): ParseOutput {
    const lines = splitLines(input.content);
    const symbols: SymbolRecord[] = [];
    const fenceLanguages: string[] = [];
    let inFence = false;
    let fenceMarker = '';

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fenceMatch = /^\s*(```+|~~~+)\s*([\w+#-]*)/.exec(line);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fenceMatch[1][0];
          if (fenceMatch[2]) {
            fenceLanguages.push(fenceMatch[2].toLowerCase());
          }
        } else if (fenceMatch[1][0] === fenceMarker) {
          inFence = false;
        }
        continue;
      }
      if (inFence) {
        continue;
      }
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading && symbols.length < MAX_HEADINGS) {
        pushSymbol(
          symbols,
          {
            name: heading[2].trim(),
            kind: 'section',
            line: i + 1,
            detail: `h${heading[1].length}`
          },
          'exact'
        );
      }
    }

    const title = symbols.find((symbol) => symbol.detail === 'h1')?.name;
    return {
      language: input.language,
      kind: input.kind,
      symbols,
      imports: [],
      references: [],
      confidence: 'exact',
      facts: {
        title,
        codeFenceLanguages: [...new Set(fenceLanguages)],
        codeFenceCount: fenceLanguages.length
      }
    };
  }
}
