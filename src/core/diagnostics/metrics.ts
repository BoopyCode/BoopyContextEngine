/**
 * Local diagnostics counters.
 *
 * Everything here is measured locally inside the extension host. BCE has no access
 * to the model provider's billing data, so token numbers are always marked as
 * estimates and must never be presented as the total Copilot/DeepSeek usage.
 */

export interface ToolStat {
  calls: number;
  characters: number;
  estimatedTokens: number;
  durationMs: number;
  errors: number;
}

export interface MetricsSnapshot {
  startedAt: number;
  counters: Record<string, number>;
  timings: Record<string, number>;
  tools: Record<string, ToolStat>;
  recentEvents: { at: number; level: string; message: string }[];
  notes: string[];
}

const MAX_EVENTS = 200;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number>();
  private readonly tools = new Map<string, ToolStat>();
  private readonly events: { at: number; level: string; message: string }[] = [];
  private readonly startedAt: number;

  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {
    this.startedAt = clock.now();
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  setCounter(counter: string, value: number): void {
    this.counters.set(counter, value);
  }

  getCounter(counter: string): number {
    return this.counters.get(counter) ?? 0;
  }

  observeTiming(name: string, durationMs: number): void {
    this.timings.set(name, durationMs);
  }

  getTiming(name: string): number {
    return this.timings.get(name) ?? 0;
  }

  recordToolCall(tool: string, characters: number, estimatedTokens: number, durationMs: number, error = false): void {
    const stat = this.tools.get(tool) ?? { calls: 0, characters: 0, estimatedTokens: 0, durationMs: 0, errors: 0 };
    stat.calls += 1;
    stat.characters += characters;
    stat.estimatedTokens += estimatedTokens;
    stat.durationMs += durationMs;
    if (error) {
      stat.errors += 1;
    }
    this.tools.set(tool, stat);
  }

  recordEvent(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    this.events.push({ at: this.clock.now(), level, message });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt,
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
      tools: Object.fromEntries(this.tools),
      recentEvents: [...this.events],
      notes: [
        'Token numbers are local estimates produced by BCE, not the model provider billing numbers.',
        'Cache hits only reduce repeated local work; re-sending the same context to a model can still be billed.'
      ]
    };
  }

  reset(): void {
    this.counters.clear();
    this.timings.clear();
    this.tools.clear();
    this.events.length = 0;
  }
}
