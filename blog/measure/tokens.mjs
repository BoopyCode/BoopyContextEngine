/**
 * Counts what a naive frontier model call would bill, so both halves of the measurement
 * use one tokenizer and one price list.
 */

import tiktoken from 'tiktoken';

export const PRICE = {
  // USD per 1M tokens. DeepSeek V4 Flash list prices (cache hit / miss / output).
  'deepseek-v4-flash': { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  // What the comparison would cost on a frontier model, for scale.
  'gpt-4o': { cacheHit: 1.25, cacheMiss: 2.5, output: 10 }
};

let encoder;
export function countTokens(text) {
  if (!encoder) encoder = tiktoken.get_encoding('cl100k_base');
  return encoder.encode(text).length;
}

/** Prices a prompt with no cache split (worst case: everything billed as a miss). */
export function cost(tokens, model = 'deepseek-v4-flash') {
  const price = PRICE[model] ?? PRICE['deepseek-v4-flash'];
  return (tokens / 1e6) * price.cacheMiss;
}

export function usd(value) {
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}
