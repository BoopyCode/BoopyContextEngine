import { describe, expect, it } from 'vitest';
import { matchSymbolTerm, nameTerms, bestMatch, SYMBOL_MATCH_WEIGHTS } from '../src/core/retrieve/symbolRanking';
import { FileRecord, SymbolRecord } from '../src/core/types';

function symbol(name: string, extra: Partial<SymbolRecord> = {}): SymbolRecord {
  return { name, kind: 'function', line: 1, confidence: 'exact', ...extra };
}

function file(path: string, symbols: SymbolRecord[]): FileRecord {
  return {
    path,
    hash: 'x',
    size: 10,
    mtimeMs: 0,
    language: 'javascript',
    kind: 'source',
    symbols,
    imports: [],
    references: [],
    dependencies: [],
    confidence: 'exact',
    indexedAt: 0
  };
}
void file;

describe('symbol ranking', () => {
  it('treats an exact name as the strongest match', () => {
    const match = matchSymbolTerm(symbol('adminAuth'), 'adminauth');
    expect(match?.kind).toBe('exact-name');
    expect(match?.weight).toBe(SYMBOL_MATCH_WEIGHTS['exact-name']);
  });

  it('matches a whole identifier word rather than an arbitrary substring', () => {
    // `adminAuth` is what a query about "auth" means; `authenticate` is not.
    expect(matchSymbolTerm(symbol('adminAuth'), 'auth')?.kind).toBe('segment-name');
    expect(matchSymbolTerm(symbol('authenticate'), 'auth')?.kind).toBe('prefix-name');
  });

  it('keeps contains clearly weaker than a word match', () => {
    const exact = matchSymbolTerm(symbol('adminAuth'), 'adminauth')!;
    const contains = matchSymbolTerm(symbol('superadminHelper'), 'admin')!;
    expect(contains.kind).toBe('substring-name');
    expect(exact.weight).toBeGreaterThan(contains.weight * 3);
  });

  it('does not fall back to a bare substring when a word segment already matched', () => {
    // `userReports` matches "report" as a word segment (13), never as the weaker
    // bare-substring rule (3) - the strongest match wins.
    expect(matchSymbolTerm(symbol('userReports'), 'report')?.kind).toBe('segment-name');
  });

  it('rates a mid-word substring well below a whole-word match', () => {
    // `superadmin` is one token: "admin" appears mid-word, so it can only reach the
    // substring rule, which pays a quarter of the whole-word rule.
    const wordMatch = matchSymbolTerm(symbol('adminAuth'), 'admin')!;
    const substringMatch = matchSymbolTerm(symbol('superadmin'), 'admin')!;
    expect(wordMatch.kind).toBe('segment-name');
    expect(substringMatch.kind).toBe('substring-name');
    expect(wordMatch.weight).toBeGreaterThan(substringMatch.weight * 3);
  });

  it('matches both parts of a qualified member name', () => {
    expect(matchSymbolTerm(symbol('Collection.add'), 'add')?.kind).toBe('segment-name');
    expect(matchSymbolTerm(symbol('Collection.add'), 'collection')?.kind).toBe('segment-name');
  });

  it('falls back to signature and doc, weakest first', () => {
    expect(matchSymbolTerm(symbol('handler', { signature: 'function handler(authToken)' }), 'authtoken')?.kind).toBe('signature');
    expect(matchSymbolTerm(symbol('handler', { doc: 'Validates the session token' }), 'session')?.kind).toBe('doc');
  });

  it('drops generic words from name matching but keeps them for hints', () => {
    const terms = ['admin', 'route', 'helper'];
    expect(nameTerms(terms)).toEqual(['admin', 'route']);
  });

  it('keeps the strongest of several matches', () => {
    const chosen = bestMatch([
      { kind: 'substring-name', term: 'a', weight: 3 },
      { kind: 'exact-name', term: 'b', weight: 16 }
    ]);
    expect(chosen?.kind).toBe('exact-name');
  });
});
