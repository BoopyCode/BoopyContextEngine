import { ProjectOverviewInput, FindContextInput, FileContextInput, ImpactInput, RelatedTestsInput, StatusInput } from './toolTypes';

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationError {
  ok: false;
  error: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationError;

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function optionalString(value: unknown, field: string, maxLength = 500): ValidationResult<string | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `"${field}" must be a string.` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, error: `"${field}" is too long (${trimmed.length} > ${maxLength} characters).` };
  }
  return { ok: true, value: trimmed };
}

function requiredString(value: unknown, field: string, maxLength = 500): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      error: `"${field}" is required and must be a non-empty string. Specify what to look for, for example "${field}": "user authentication".`
    };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, error: `"${field}" is too long (${trimmed.length} > ${maxLength} characters). Use a shorter, more specific query.` };
  }
  return { ok: true, value: trimmed };
}

function optionalNumber(value: unknown, field: string, min: number, max: number): ValidationResult<number | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return { ok: false, error: `"${field}" must be a number.` };
  }
  const rounded = Math.round(numeric);
  if (rounded < min || rounded > max) {
    return { ok: false, error: `"${field}" must be between ${min} and ${max} (received ${rounded}).` };
  }
  return { ok: true, value: rounded };
}

function optionalBoolean(value: unknown, field: string): ValidationResult<boolean | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (value === 'true' || value === 'false') {
    return { ok: true, value: value === 'true' };
  }
  return { ok: false, error: `"${field}" must be true or false.` };
}

export function validateProjectOverviewInput(input: unknown): ValidationResult<ProjectOverviewInput> {
  const raw = asRecord(input);
  const focus = optionalString(raw.focus, 'focus', 120);
  if (!focus.ok) {
    return focus;
  }
  const maxTokens = optionalNumber(raw.maxTokens, 'maxTokens', 200, 20000);
  if (!maxTokens.ok) {
    return maxTokens;
  }
  return { ok: true, value: { focus: focus.value, maxTokens: maxTokens.value } };
}

export function validateFindContextInput(input: unknown): ValidationResult<FindContextInput> {
  const raw = asRecord(input);
  const query = requiredString(raw.query, 'query', 500);
  if (!query.ok) {
    return query;
  }
  const scope = optionalString(raw.scope, 'scope', 300);
  if (!scope.ok) {
    return scope;
  }
  const maxTokens = optionalNumber(raw.maxTokens, 'maxTokens', 200, 20000);
  if (!maxTokens.ok) {
    return maxTokens;
  }
  const includeTests = optionalBoolean(raw.includeTests, 'includeTests');
  if (!includeTests.ok) {
    return includeTests;
  }
  const includeSnippets = optionalBoolean(raw.includeSnippets, 'includeSnippets');
  if (!includeSnippets.ok) {
    return includeSnippets;
  }
  const symbolsOnly = optionalBoolean(raw.symbolsOnly, 'symbolsOnly');
  if (!symbolsOnly.ok) {
    return symbolsOnly;
  }
  return {
    ok: true,
    value: {
      query: query.value,
      scope: scope.value,
      maxTokens: maxTokens.value,
      includeTests: includeTests.value,
      includeSnippets: includeSnippets.value,
      symbolsOnly: symbolsOnly.value
    }
  };
}

export function validateFileContextInput(input: unknown): ValidationResult<FileContextInput> {
  const raw = asRecord(input);
  const path = requiredString(raw.path, 'path', 1000);
  if (!path.ok) {
    return path;
  }
  const symbol = optionalString(raw.symbol, 'symbol', 200);
  if (!symbol.ok) {
    return symbol;
  }
  const startLine = optionalNumber(raw.startLine, 'startLine', 1, 10_000_000);
  if (!startLine.ok) {
    return startLine;
  }
  const endLine = optionalNumber(raw.endLine, 'endLine', 1, 10_000_000);
  if (!endLine.ok) {
    return endLine;
  }
  if (startLine.value !== undefined && endLine.value !== undefined && endLine.value < startLine.value) {
    return { ok: false, error: '"endLine" must be greater than or equal to "startLine".' };
  }
  const maxTokens = optionalNumber(raw.maxTokens, 'maxTokens', 200, 20000);
  if (!maxTokens.ok) {
    return maxTokens;
  }
  return {
    ok: true,
    value: { path: path.value, symbol: symbol.value, startLine: startLine.value, endLine: endLine.value, maxTokens: maxTokens.value }
  };
}

export function validateImpactInput(input: unknown): ValidationResult<ImpactInput> {
  const raw = asRecord(input);
  const path = optionalString(raw.path, 'path', 1000);
  if (!path.ok) {
    return path;
  }
  const symbol = optionalString(raw.symbol, 'symbol', 200);
  if (!symbol.ok) {
    return symbol;
  }
  const maxTokens = optionalNumber(raw.maxTokens, 'maxTokens', 200, 20000);
  if (!maxTokens.ok) {
    return maxTokens;
  }
  if (path.value === undefined && symbol.value === undefined) {
    return { ok: false, error: 'Provide "symbol" or "path" (or both) so BCE knows what to analyze.' };
  }
  return { ok: true, value: { path: path.value, symbol: symbol.value, maxTokens: maxTokens.value } };
}

export function validateRelatedTestsInput(input: unknown): ValidationResult<RelatedTestsInput> {
  const result = validateImpactInput(input);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: { path: result.value.path, symbol: result.value.symbol, maxTokens: result.value.maxTokens } };
}

export function validateStatusInput(input: unknown): ValidationResult<StatusInput> {
  const raw = asRecord(input);
  const verbose = optionalBoolean(raw.verbose, 'verbose');
  if (!verbose.ok) {
    return verbose;
  }
  return { ok: true, value: { verbose: verbose.value } };
}
