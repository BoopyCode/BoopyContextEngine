import { FileParser, ParseInput, ParseOutput } from './parseTypes';
import { TsJsParser } from './parsers/tsjs';
import { PhpParser } from './parsers/php';
import { PythonParser } from './parsers/python';
import { SqlParser } from './parsers/sql';
import { JsonParser } from './parsers/json';
import { MarkdownParser } from './parsers/markdown';
import { YamlParser } from './parsers/yaml';
import { DockerfileParser } from './parsers/dockerfile';
import { TextParser } from './parsers/text';
import { LanguageInfo } from './languages';

export const SCHEMA_VERSION = 1;

export class ParserRegistry {
  private readonly parsers = new Map<string, FileParser>();

  constructor(parsers: FileParser[] = defaultParsers()) {
    for (const parser of parsers) {
      this.parsers.set(parser.id, parser);
    }
  }

  get(parserId: LanguageInfo['parser']): FileParser | undefined {
    return this.parsers.get(parserId);
  }

  /** Version string of every parser; stored with the index to invalidate stale caches. */
  get version(): string {
    return [...this.parsers.values()]
      .map((parser) => `${parser.id}@${parser.version}`)
      .sort()
      .join(',');
  }

  /** Runs the parser for a file. Returns undefined when the file type has no parser. */
  parse(input: ParseInput, parserId: LanguageInfo['parser']): ParseOutput | undefined {
    const parser = this.get(parserId);
    if (!parser) {
      return undefined;
    }
    return parser.parse(input);
  }
}

export function defaultParsers(): FileParser[] {
  return [
    new TsJsParser(),
    new PhpParser(),
    new PythonParser(),
    new SqlParser(),
    new JsonParser(),
    new MarkdownParser(),
    new YamlParser(),
    new DockerfileParser(),
    new TextParser()
  ];
}
