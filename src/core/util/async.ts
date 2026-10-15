/** Cancellation, clock and scheduling abstractions so that core logic stays testable. */

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export const neverCancelled: CancellationLike = {
  isCancellationRequested: false
};

export function isCancelled(token: CancellationLike | undefined): boolean {
  return token?.isCancellationRequested === true;
}

export class OperationCancelledError extends Error {
  constructor(operation: string) {
    super(`${operation} was cancelled.`);
    this.name = 'OperationCancelledError';
  }
}

/** Cancellation source shared by the extension host and the core pipeline. */
export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners: (() => void)[] = [];

  readonly token: CancellationLike & { onCancellationRequested(listener: () => void): { dispose(): void } } = {
    isCancellationRequested: false,
    onCancellationRequested: (): { dispose(): void } => ({ dispose: () => undefined })
  };

  constructor() {
    const self = this;
    Object.defineProperty(this.token, 'isCancellationRequested', {
      get: () => self.cancelled
    });
    this.token.onCancellationRequested = (listener: () => void) => {
      if (self.cancelled) {
        listener();
        return { dispose: () => undefined };
      }
      self.listeners.push(listener);
      return {
        dispose: () => {
          const index = self.listeners.indexOf(listener);
          if (index >= 0) {
            self.listeners.splice(index, 1);
          }
        }
      };
    };
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
    this.listeners.length = 0;
  }
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now()
};

export interface TimerHandle {
  cancel(): void;
}

export interface Scheduler {
  schedule(callback: () => void, delayMs: number): TimerHandle;
}

export const systemScheduler: Scheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  }
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gives the Extension Host a chance to process pending work (UI events, watchers,
 * language features) between chunks of CPU bound indexing work.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
    if (typeof immediate === 'function') {
      immediate(() => resolve());
      return;
    }
    setTimeout(() => resolve(), 0);
  });
}

/**
 * Coalesces bursts of calls into a single trailing call, with an upper bound so
 * that a long stream of events cannot postpone the work forever.
 */
export class Debouncer {
  private handle: TimerHandle | undefined;
  private firstQueuedAt: number | undefined;

  constructor(
    private readonly waitMs: number,
    private readonly maxWaitMs: number,
    private readonly callback: () => void,
    private readonly scheduler: Scheduler = systemScheduler,
    private readonly clock: Clock = systemClock
  ) {}

  trigger(): void {
    const now = this.clock.now();
    if (this.firstQueuedAt === undefined) {
      this.firstQueuedAt = now;
    }
    const elapsed = now - this.firstQueuedAt;
    const wait = Math.max(1, Math.min(this.waitMs, this.maxWaitMs - elapsed));
    this.handle?.cancel();
    this.handle = this.scheduler.schedule(() => this.flush(), wait);
  }

  flush(): void {
    this.handle?.cancel();
    this.handle = undefined;
    this.firstQueuedAt = undefined;
    this.callback();
  }

  dispose(): void {
    this.handle?.cancel();
    this.handle = undefined;
    this.firstQueuedAt = undefined;
  }

  get pending(): boolean {
    return this.handle !== undefined;
  }
}

/** Runs tasks with a bounded degree of parallelism, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  token?: CancellationLike
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = new Array(workerCount).fill(0).map(async () => {
    for (;;) {
      if (isCancelled(token)) {
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
