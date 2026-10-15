import { StoreFs } from '../io/storeFs';

export const USAGE_LOG_FILE = 'usage.jsonl';

/** Records kept in memory (and therefore in the report). Older ones stay in the log file. */
const MAX_RECORDS = 2000;
/** The log is rotated when it grows past this, keeping the newest lines. */
const MAX_LOG_BYTES = 512 * 1024;
const KEEP_LINES_ON_ROTATE = 1000;

export interface UsageRecord {
  /** Epoch milliseconds. */
  at: number;
  tool: string;
  /** What was asked, shortened for the report (query, path, symbol). */
  label?: string;
  /** Estimated tokens BCE returned for this call. */
  returnedTokens: number;
  characters: number;
  /** Estimated tokens of the naive alternative, when one can be defined for this tool. */
  baselineTokens?: number;
  /** Files that naive alternative would have covered. */
  baselineFiles?: number;
  /** Files the tool looked at before ranking. */
  candidateFiles?: number;
  durationMs: number;
  error?: boolean;
}

export interface UsageTotals {
  calls: number;
  errors: number;
  /** Calls that have a defensible naive baseline. */
  callsWithBaseline: number;
  returnedTokens: number;
  baselineTokens: number;
  /** baselineTokens - returnedTokens, floored at 0. */
  savedTokens: number;
  savedPercent: number;
  firstAt: number;
  lastAt: number;
}

export interface UsageSummary {
  rootName: string;
  logFile: string;
  /** False when the user turned the log off; the report then only covers the live session. */
  persisted: boolean;
  updatedAt: number;
  totals: UsageTotals;
  perTool: { tool: string; totals: UsageTotals }[];
  /** Newest first. */
  recent: UsageRecord[];
}

export interface UsageLedgerDeps {
  store: StoreFs;
  rootName: string;
  /** Re-read on every record, so the setting takes effect without a reload. */
  enabled: () => boolean;
  clock?: { now(): number };
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

/**
 * Append only log of what the BCE tools returned, plus a local estimate of what reading the
 * files the naive way would have cost.
 *
 * Honest limits, repeated in the report: numbers come from the local estimator, not from the
 * model provider, and they measure context size - not answer quality. The file lives in BCE's
 * own storage, is never uploaded, and can be deleted with `BCE: Reset Usage Log`.
 */
export class UsageLedger {
  private records: UsageRecord[] = [];
  private pending: Promise<void> = Promise.resolve();
  private warned = false;

  private constructor(private readonly deps: UsageLedgerDeps, records: UsageRecord[], private readonly logPath: string) {
    this.records = records;
  }

  static async load(deps: UsageLedgerDeps): Promise<UsageLedger> {
    let records: UsageRecord[] = [];
    try {
      const text = await deps.store.readText(USAGE_LOG_FILE);
      records = parseUsageLog(text);
    } catch {
      // No log yet, or it is unreadable: start empty instead of failing the session.
    }
    return new UsageLedger(deps, records, USAGE_LOG_FILE);
  }

  /** Relative path of the log inside BCE's storage. */
  get file(): string {
    return this.logPath;
  }

  get size(): number {
    return this.records.length;
  }

  get isPersisted(): boolean {
    return this.deps.enabled();
  }

  record(entry: Omit<UsageRecord, 'at'> & { at?: number }): UsageRecord {
    const record: UsageRecord = { at: entry.at ?? this.now(), ...entry };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    if (!this.deps.enabled()) {
      return record;
    }
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(() => this.append(line))
      .catch(() => undefined);
    return record;
  }

  totals(): UsageTotals {
    return computeTotals(this.records);
  }

  summary(): UsageSummary {
    const byTool = new Map<string, UsageRecord[]>();
    for (const record of this.records) {
      const list = byTool.get(record.tool);
      if (list) {
        list.push(record);
      } else {
        byTool.set(record.tool, [record]);
      }
    }
    return {
      rootName: this.deps.rootName,
      logFile: this.logPath,
      persisted: this.deps.enabled(),
      updatedAt: this.now(),
      totals: this.totals(),
      perTool: [...byTool.entries()]
        .map(([tool, records]) => ({ tool, totals: computeTotals(records) }))
        .sort((a, b) => b.totals.calls - a.totals.calls),
      recent: [...this.records].reverse()
    };
  }

  /** Waits for the queued writes; used before reporting or on shutdown. */
  async flush(): Promise<void> {
    await this.pending;
  }

  async clear(): Promise<void> {
    this.records = [];
    await this.pending;
    try {
      await this.deps.store.remove(USAGE_LOG_FILE);
    } catch (error) {
      this.deps.log?.('warn', `Could not delete the usage log: ${describe(error)}`);
    }
  }

  private now(): number {
    return this.deps.clock?.now() ?? Date.now();
  }

  private async append(line: string): Promise<void> {
    try {
      await this.deps.store.appendText(USAGE_LOG_FILE, line);
      const stat = await this.deps.store.stat(USAGE_LOG_FILE);
      if (stat && stat.size > MAX_LOG_BYTES) {
        await this.rotate();
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.deps.log?.('warn', `Usage log could not be written (${describe(error)}); usage is still reported for this session.`);
      }
    }
  }

  /** Keeps the newest lines: usage history should not grow without bound. */
  private async rotate(): Promise<void> {
    const text = await this.deps.store.readText(USAGE_LOG_FILE);
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const kept = lines.slice(Math.max(0, lines.length - KEEP_LINES_ON_ROTATE));
    await this.deps.store.writeTextAtomic(USAGE_LOG_FILE, `${kept.join('\n')}\n`);
    this.deps.log?.('debug', `Usage log rotated, ${kept.length} newest entry/entries kept.`);
  }
}

export function computeTotals(records: readonly UsageRecord[]): UsageTotals {
  const totals: UsageTotals = {
    calls: 0,
    errors: 0,
    callsWithBaseline: 0,
    returnedTokens: 0,
    baselineTokens: 0,
    savedTokens: 0,
    savedPercent: 0,
    firstAt: 0,
    lastAt: 0
  };
  for (const record of records) {
    totals.calls += 1;
    if (record.error) {
      totals.errors += 1;
    }
    totals.returnedTokens += record.returnedTokens;
    if (typeof record.baselineTokens === 'number') {
      totals.callsWithBaseline += 1;
      totals.baselineTokens += record.baselineTokens;
    }
    totals.firstAt = totals.firstAt === 0 ? record.at : Math.min(totals.firstAt, record.at);
    totals.lastAt = Math.max(totals.lastAt, record.at);
  }
  totals.savedTokens = Math.max(0, totals.baselineTokens - totals.returnedTokens);
  totals.savedPercent =
    totals.baselineTokens === 0 ? 0 : Math.round(((totals.baselineTokens - totals.returnedTokens) / totals.baselineTokens) * 1000) / 10;
  return totals;
}

export function parseUsageLog(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as UsageRecord;
      if (typeof parsed?.at === 'number' && typeof parsed?.tool === 'string') {
        records.push({
          at: parsed.at,
          tool: parsed.tool,
          label: typeof parsed.label === 'string' ? parsed.label : undefined,
          returnedTokens: numberOr(parsed.returnedTokens, 0),
          characters: numberOr(parsed.characters, 0),
          baselineTokens: typeof parsed.baselineTokens === 'number' ? parsed.baselineTokens : undefined,
          baselineFiles: typeof parsed.baselineFiles === 'number' ? parsed.baselineFiles : undefined,
          candidateFiles: typeof parsed.candidateFiles === 'number' ? parsed.candidateFiles : undefined,
          durationMs: numberOr(parsed.durationMs, 0),
          error: parsed.error === true ? true : undefined
        });
      }
    } catch {
      // A damaged line must not lose the rest of the history.
    }
  }
  return records.slice(Math.max(0, records.length - MAX_RECORDS));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderUsageReport(summary: UsageSummary): string {
  const lines: string[] = [];
  const totals = summary.totals;
  lines.push(`# BCE usage log - ${summary.rootName}`);
  lines.push('');
  lines.push(
    `entries: ${totals.calls}${totals.calls > 0 ? ` (first ${formatTime(totals.firstAt)}, last ${formatTime(totals.lastAt)})` : ''}`
  );
  lines.push(`log file: ${summary.logFile}${summary.persisted ? '' : ' (logging is turned off, only this session is shown)'}`);
  lines.push('');
  lines.push('## What the tools returned');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| tool calls | ${totals.calls}${totals.errors > 0 ? ` (${totals.errors} failed)` : ''} |`);
  lines.push(`| estimated tokens returned by BCE | ~${totals.returnedTokens} |`);
  lines.push(
    `| estimated tokens of the naive alternative | ~${totals.baselineTokens} (over ${totals.callsWithBaseline} call(s) where it can be defined) |`
  );
  lines.push(`| estimated tokens avoided | ~${totals.savedTokens} (${totals.savedPercent}% smaller) |`);
  lines.push('');

  if (summary.perTool.length > 0) {
    lines.push('## Per tool');
    lines.push('');
    lines.push('| tool | calls | returned | naive baseline | avoided |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of summary.perTool) {
      lines.push(
        `| ${entry.tool} | ${entry.totals.calls} | ~${entry.totals.returnedTokens} | ${entry.totals.callsWithBaseline > 0 ? `~${entry.totals.baselineTokens}` : 'n/a'} | ${
          entry.totals.callsWithBaseline > 0 ? `~${entry.totals.savedTokens}` : 'n/a'
        } |`
      );
    }
    lines.push('');
  }

  if (summary.recent.length > 0) {
    lines.push('## Recent calls (newest first)');
    lines.push('');
    lines.push('| when | tool | what | returned | baseline | ms |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const record of summary.recent.slice(0, 20)) {
      lines.push(
        `| ${formatTime(record.at)} | ${record.tool} | ${escapeCell(record.label)} | ~${record.returnedTokens} | ${
          typeof record.baselineTokens === 'number' ? `~${record.baselineTokens}` : 'n/a'
        } | ${Math.round(record.durationMs)} |`
      );
    }
    lines.push('');
  }

  lines.push('## How to read this');
  lines.push('');
  lines.push(
    '* Token numbers are **local estimates** from the character based estimator, not the model provider\'s billing. An extension cannot see the provider account.'
  );
  lines.push(
    '* The naive baseline is an upper bound: reading every file whose path or symbol names match a query term. A real agent may read fewer files (and miss the answer) or more (and waste tokens).'
  );
  lines.push(
    '* Only `bce_find_context` and `bce_get_file_context` have a baseline; for the other tools the table shows the returned size only.'
  );
  lines.push(
    '* Answer quality, agent step count and billed usage need an A/B run in a real chat - see `docs/BENCHMARK.md` section 5.'
  );
  lines.push('');
  return lines.join('\n');
}

function formatTime(at: number): string {
  return at === 0 ? 'never' : new Date(at).toISOString().replace('T', ' ').slice(0, 19);
}

function escapeCell(value: string | undefined): string {
  if (!value) {
    return '(none)';
  }
  const single = value.replace(/\s+/g, ' ');
  return (single.length > 60 ? `${single.slice(0, 57)}...` : single).replace(/\|/g, '\\|');
}
