import { withLineNumbers } from '../util/text';

export interface LineRange {
  start: number;
  end: number;
}

/** Clamps ranges to the file and merges those that are close together. */
export function mergeRanges(ranges: LineRange[], lineCount: number, maxGap = 4): LineRange[] {
  const clamped = ranges
    .map((range) => ({ start: Math.max(1, Math.min(range.start, lineCount)), end: Math.max(1, Math.min(range.end, lineCount)) }))
    .filter((range) => range.end >= range.start)
    .sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + maxGap) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export interface SnippetResult {
  text: string;
  lines: number;
  ranges: LineRange[];
  truncated: boolean;
}

/**
 * Renders the requested line ranges with a line number gutter. Disjoint ranges are
 * separated by a `...` marker so the model can tell that lines are missing.
 */
export function renderSnippet(content: string, ranges: LineRange[], maxLines: number): SnippetResult {
  const allLines = content.replace(/\r\n/g, '\n').split('\n');
  const merged = mergeRanges(ranges, allLines.length);
  const blocks: string[] = [];
  let usedLines = 0;
  let truncated = false;
  const keptRanges: LineRange[] = [];

  for (const range of merged) {
    if (usedLines >= maxLines) {
      truncated = true;
      break;
    }
    const end = Math.min(range.end, range.start + (maxLines - usedLines) - 1);
    if (end < range.end) {
      truncated = true;
    }
    const slice = allLines.slice(range.start - 1, end);
    blocks.push(withLineNumbers(slice, range.start).join('\n'));
    usedLines += slice.length;
    keptRanges.push({ start: range.start, end });
  }

  return { text: blocks.join('\n...\n'), lines: usedLines, ranges: keptRanges, truncated };
}

/** A short single-line preview of a symbol declaration. */
export function symbolPreview(line: string | undefined, maxLength = 120): string | undefined {
  if (!line) {
    return undefined;
  }
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}
