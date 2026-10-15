/**
 * Token estimation.
 *
 * BCE never has access to the real billing numbers of an external model, so it
 * only ever reports a *labelled estimate*. The method string travels with every
 * number so no consumer can mistake it for an exact count.
 */

export interface TokenEstimate {
  tokens: number;
  method: string;
  exact: false;
}

export const HEURISTIC_METHOD = 'heuristic:chars/4+tokens-correction';

export interface TokenEstimator {
  readonly method: string;
  readonly exact: boolean;
  estimate(text: string): number;
}

/**
 * Character based estimator tuned for source code. Code has shorter average
 * tokens than prose, so a pure `chars / 4` rule underestimates identifiers and
 * punctuation-heavy lines; the correction below is deliberately slightly
 * pessimistic (over-estimating is safer for budgeting).
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  readonly method = HEURISTIC_METHOD;
  readonly exact = false;

  estimate(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    const byChars = text.length / 4;
    const words = text.split(/\s+/).filter((word) => word.length > 0).length;
    const punctuation = (text.match(/[^\w\s]/g) ?? []).length;
    const byWords = words * 1.3 + punctuation * 0.6;
    return Math.max(1, Math.ceil(Math.max(byChars, byWords) * 1.05));
  }
}

export const defaultTokenEstimator: TokenEstimator = new HeuristicTokenEstimator();

export function estimateTokens(text: string, estimator: TokenEstimator = defaultTokenEstimator): number {
  return estimator.estimate(text);
}

export function formatTokenEstimate(tokens: number, estimator: TokenEstimator = defaultTokenEstimator): string {
  return `~${tokens} tokens (${estimator.method})`;
}

export const TOKEN_ESTIMATE_DISCLAIMER =
  'Token numbers reported by BCE are local estimates, not the model provider billing numbers.';

/**
 * A budgeted text accumulator: it accepts pieces of text until the token budget
 * is exhausted and reports how much was kept and whether anything was dropped.
 */
export class TokenBudget {
  private readonly parts: string[] = [];
  private usedTokens = 0;
  private droppedTokens = 0;

  constructor(
    readonly maxTokens: number,
    private readonly estimator: TokenEstimator = defaultTokenEstimator
  ) {}

  get used(): number {
    return this.usedTokens;
  }

  get dropped(): number {
    return this.droppedTokens;
  }

  get truncated(): boolean {
    return this.droppedTokens > 0;
  }

  get remaining(): number {
    return Math.max(0, this.maxTokens - this.usedTokens);
  }

  /** Returns true when the text was fully accepted. */
  tryAdd(text: string): boolean {
    if (text.length === 0) {
      return true;
    }
    const cost = this.estimator.estimate(text);
    if (this.usedTokens + cost > this.maxTokens) {
      this.droppedTokens += cost;
      return false;
    }
    this.parts.push(text);
    this.usedTokens += cost;
    return true;
  }

  /**
   * Adds as many lines as fit into the remaining budget.
   * Returns true when every line was accepted.
   */
  tryAddLines(lines: string[]): boolean {
    return this.tryAdd(lines.join('\n'));
  }

  toString(): string {
    return this.parts.join('');
  }
}
