import { ProjectIndex } from '../index/indexModel';
import { splitIdentifier } from '../util/paths';

export interface NaiveBaseline {
  /** Files whose path or symbol names contain a query term. */
  files: number;
  /** Estimated tokens of reading all of them (`size / 4`). */
  estimatedTokens: number;
  paths: string[];
}

/**
 * Local estimate of the naive alternative to a BCE lookup: reading every file whose path or
 * symbol names contain a term of the query.
 *
 * It is an upper bound of the work avoided, not a promise of quality: a naive agent may read
 * fewer files (and miss the right one) or more (and waste tokens). The number is always
 * labelled as an estimate in every surface that shows it.
 */
export function estimateNaiveBaseline(
  index: ProjectIndex,
  query: string,
  options: { includeTests?: boolean } = {}
): NaiveBaseline {
  const terms = splitIdentifier(query.toLowerCase());
  const includeTests = options.includeTests ?? true;

  const files = index.allFiles().filter((file) => {
    if (!includeTests && file.kind === 'test') {
      return false;
    }
    const haystack = `${file.path.toLowerCase()} ${file.symbols.map((symbol) => symbol.name.toLowerCase()).join(' ')}`;
    return terms.some((term: string) => term.length >= 3 && haystack.includes(term));
  });

  return {
    files: files.length,
    estimatedTokens: files.reduce((total, file) => total + Math.round(file.size / 4), 0),
    paths: files.map((file) => file.path)
  };
}
