import { FileRecord, SymbolRecord } from '../types';
import { baseName, splitIdentifier } from '../util/paths';

/**
 * How a query term matched a symbol. Ordered strongest first; the weights below
 * assume that order, so the strongest match short-circuits the weaker ones.
 */
export type SymbolMatchKind =
  | 'exact-name'
  | 'segment-name'
  | 'qualified-name'
  | 'prefix-name'
  | 'substring-name'
  | 'signature'
  | 'doc';

/** Score contributed by each match kind (a single symbol keeps only its best match). */
export const SYMBOL_MATCH_WEIGHTS: Record<SymbolMatchKind, number> = {
  'exact-name': 16,
  'segment-name': 13,
  'qualified-name': 12,
  'prefix-name': 7,
  'substring-name': 3,
  signature: 1.5,
  doc: 0.5
};

/**
 * Declaration kinds that a query usually means when it names something.
 * A symbol whose kind is reinforced by a hint word in the query ("route",
 * "table", "component") is worth more than the same name matched by luck.
 */
export const SYMBOL_KIND_BONUS = 3;

/** A symbol defined in a file the query already names is very unlikely to be a coincidence. */
export const TERM_FILE_AFFINITY = 5;

/**
 * Words that carry no target meaning on their own. They are still useful as
 * *hints* ("route", "test"), so they are dropped from name matching instead of
 * being removed from the query.
 */
export const GENERIC_NAME_TERMS = new Set([
  'code',
  'function',
  'functions',
  'method',
  'methods',
  'handler',
  'handlers',
  'helper',
  'helpers',
  'util',
  'utils',
  'the',
  'and',
  'with',
  'for'
]);

export interface SymbolMatch {
  kind: SymbolMatchKind;
  term: string;
  weight: number;
}

/** Strips a simple English plural so `reports` and `report` compare equal. */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 3 && (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes') || word.endsWith('ches') || word.endsWith('shes'))) {
    return word.slice(0, -2);
  }
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Scores a single query term against a symbol name.
 *
 * The order matters: a symbol named exactly like the term is a much stronger
 * signal than one that merely contains the term as a substring, and the old
 * ranking treated `contains` as almost as good as `equals`. That is what let
 * 27 unrelated `*admin*` routes outrank the one `adminAuth` the query meant.
 */
export function matchSymbolTerm(symbol: SymbolRecord, term: string): SymbolMatch | undefined {
  const name = symbol.name;
  const lowerName = name.toLowerCase();
  const needle = term.toLowerCase();

  if (lowerName === needle) {
    return { kind: 'exact-name', term, weight: SYMBOL_MATCH_WEIGHTS['exact-name'] };
  }

  // `adminAuth` should match the term "auth": identifiers are split into words,
  // and a whole word is a far better signal than an arbitrary substring.
  // `splitIdentifier` preserves the original casing, so both sides are lowered,
  // and a trailing plural is ignored so `userReports` still matches "report".
  const segments = splitIdentifier(name).map((segment) => segment.toLowerCase());
  if (segments.includes(needle) || segments.some((segment) => singularize(segment) === needle || segment === singularize(needle))) {
    return { kind: 'segment-name', term, weight: SYMBOL_MATCH_WEIGHTS['segment-name'] };
  }

  if (needle.length >= 3 && lowerName.startsWith(needle)) {
    return { kind: 'prefix-name', term, weight: SYMBOL_MATCH_WEIGHTS['prefix-name'] };
  }

  // A very short term matches half the workspace; require a little more context.
  if (needle.length >= 5 && lowerName.includes(needle)) {
    return { kind: 'substring-name', term, weight: SYMBOL_MATCH_WEIGHTS['substring-name'] };
  }

  const signature = (symbol.signature ?? '').toLowerCase();
  if (needle.length >= 4 && signature.includes(needle)) {
    return { kind: 'signature', term, weight: SYMBOL_MATCH_WEIGHTS.signature };
  }

  const doc = (symbol.doc ?? '').toLowerCase();
  if (needle.length >= 4 && doc.includes(needle)) {
    return { kind: 'doc', term, weight: SYMBOL_MATCH_WEIGHTS.doc };
  }

  return undefined;
}

/** Terms that should be tried against symbol names (hint words and stop words removed). */
export function nameTerms(terms: readonly string[]): string[] {
  return terms.filter((term) => !GENERIC_NAME_TERMS.has(term));
}

/**
 * True when a term reads like the name of the file it lives in (`adminAuth` in a
 * file about admin). This is the signal that separates "this file is about the
 * query" from "this file happens to use one of the words".
 */
export function fileTermsOf(file: FileRecord): Set<string> {
  return new Set([...splitIdentifier(file.path), ...splitIdentifier(baseName(file.path))].map((part) => part.toLowerCase()));
}

/** Keeps the strongest match when several terms match the same symbol. */
export function bestMatch(matches: readonly SymbolMatch[]): SymbolMatch | undefined {
  let best: SymbolMatch | undefined;
  for (const match of matches) {
    if (!best || match.weight > best.weight) {
      best = match;
    }
  }
  return best;
}
