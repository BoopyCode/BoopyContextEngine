/** Small text helpers shared by scanners and parsers. */

const MAX_SIGNATURE_LENGTH = 200;

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

export function trimSignature(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_SIGNATURE_LENGTH ? `${trimmed.slice(0, MAX_SIGNATURE_LENGTH - 3)}...` : trimmed;
}

export interface MaskResult {
  /** Code with strings and comments replaced by spaces; line count is preserved. */
  masked: string;
  /** Masked lines, 1:1 with the original lines. */
  lines: string[];
}

export interface MaskOptions {
  /** Treat `#` as a line comment (PHP, Python, shell). */
  hashComments?: boolean;
  /** Line comment token, defaults to `//`. */
  lineComment?: string;
}

/**
 * Replaces string literals and comments with spaces so that regex based scanners
 * do not report symbols that only exist inside a comment or a string.
 * Line structure is preserved, so line numbers stay valid.
 */
export function maskCode(text: string, options: MaskOptions = {}): MaskResult {
  const lineComment = options.lineComment ?? '//';
  const hashComments = options.hashComments ?? false;
  const source = text.replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlockComment = false;
  let inTemplate = false;
  let templateDepth = 0;

  for (const line of source.split('\n')) {
    let index = 0;
    let maskedLine = '';
    while (index < line.length) {
      const char = line[index];
      const next = line[index + 1];

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          maskedLine += '  ';
          index += 2;
          continue;
        }
        maskedLine += ' ';
        index += 1;
        continue;
      }

      if (inTemplate) {
        if (char === '\\') {
          maskedLine += '  ';
          index += 2;
          continue;
        }
        if (char === '$' && next === '{') {
          templateDepth += 1;
          maskedLine += '  ';
          index += 2;
          continue;
        }
        if (char === '}' && templateDepth > 0) {
          templateDepth -= 1;
          maskedLine += ' ';
          index += 1;
          continue;
        }
        if (char === '`' && templateDepth === 0) {
          inTemplate = false;
        }
        // Keep interpolation content visible so that identifiers used only inside
        // template literals are still counted as references.
        maskedLine += templateDepth > 0 ? char : ' ';
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        maskedLine += '  ';
        index += 2;
        continue;
      }
      if (lineComment.length === 2 && char === lineComment[0] && next === lineComment[1]) {
        maskedLine += ' '.repeat(line.length - index);
        index = line.length;
        continue;
      }
      if (hashComments && char === '#') {
        maskedLine += ' '.repeat(line.length - index);
        index = line.length;
        continue;
      }
      if (char === '"' || char === "'") {
        maskedLine += ' ';
        index += 1;
        while (index < line.length) {
          if (line[index] === '\\') {
            maskedLine += '  ';
            index += 2;
            continue;
          }
          if (line[index] === char) {
            maskedLine += ' ';
            index += 1;
            break;
          }
          maskedLine += ' ';
          index += 1;
        }
        continue;
      }
      if (char === '`') {
        inTemplate = true;
        templateDepth = 0;
        maskedLine += ' ';
        index += 1;
        continue;
      }

      maskedLine += char;
      index += 1;
    }
    out.push(maskedLine);
  }

  return { masked: out.join('\n'), lines: out };
}

/** Extracts the first meaningful line of a doc comment block above `lineIndex0`. */
export function docCommentAbove(originalLines: string[], lineIndex0: number): string | undefined {
  let cursor = lineIndex0 - 1;
  const collected: string[] = [];
  let sawComment = false;
  while (cursor >= 0 && collected.length < 12) {
    const raw = originalLines[cursor].trim();
    if (raw === '') {
      if (sawComment) {
        break;
      }
      cursor -= 1;
      continue;
    }
    if (raw.startsWith('///') || raw.startsWith('//')) {
      sawComment = true;
      collected.unshift(raw.replace(/^\/\/\/?/, '').trim());
    } else if (raw.startsWith('*') || raw.startsWith('/*')) {
      sawComment = true;
      collected.unshift(raw.replace(/^\/\*\*?/, '').replace(/^\*/, '').trim());
    } else if (raw.startsWith('#')) {
      sawComment = true;
      collected.unshift(raw.replace(/^#+/, '').trim());
    } else if (raw.endsWith('*/')) {
      sawComment = true;
      collected.unshift(raw.replace(/\*\/$/, '').replace(/^\*/, '').trim());
    } else {
      break;
    }
    cursor -= 1;
  }
  const text = collected.filter((part) => part.length > 0).join(' ').trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Finds the 1-based line where a brace-delimited declaration starting at
 * `startLine0` closes, using masked source.
 */
export function findBlockEnd(maskedLines: string[], startLine0: number, maxLines = 600): number | undefined {
  let depth = 0;
  let started = false;
  for (let i = startLine0; i < Math.min(maskedLines.length, startLine0 + maxLines); i += 1) {
    const line = maskedLines[i];
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        started = true;
      } else if (char === '}') {
        depth -= 1;
        if (started && depth <= 0) {
          return i + 1;
        }
      }
    }
    if (!started && line.trim().endsWith(';')) {
      return i + 1;
    }
  }
  return undefined;
}

/** Indentation based block end (Python style). Returns a 1-based end line. */
export function findIndentBlockEnd(lines: string[], startLine0: number, maxLines = 600): number | undefined {
  const header = lines[startLine0] ?? '';
  const headerIndent = header.length - header.trimStart().length;
  let lastContent = startLine0;
  for (let i = startLine0 + 1; i < Math.min(lines.length, startLine0 + maxLines); i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= headerIndent) {
      return lastContent + 1;
    }
    lastContent = i;
  }
  return lastContent + 1;
}

/** Brace depth at the start of every line (masked source). */
export function braceDepths(maskedLines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of maskedLines) {
    depths.push(depth);
    for (const char of line) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
    }
  }
  return depths;
}

/** Appends a line number gutter to a code slice, for compact tool output. */
export function withLineNumbers(lines: string[], startLine: number): string[] {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')}| ${line}`);
}
