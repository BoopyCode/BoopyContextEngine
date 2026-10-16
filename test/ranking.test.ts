import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { runFindContext } from '../src/core/tools/handlers';
import { symbolMatchDecay } from '../src/core/retrieve/symbolRanking';

const harnesses: Harness[] = [];

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

function options(partial: Partial<Parameters<Harness['intelligence']['retrieve']>[0]> = {}) {
  return {
    query: 'placeholder',
    maxTokens: 1200,
    includeTests: true,
    includeSnippets: true,
    maxResults: 8,
    snippetLines: 6,
    ...partial
  };
}

/**
 * The fixture has one file with far more symbols than any other
 * (`src/index.ts` re-exports, `routes/api.php`, the PHP controller). These tests
 * pin down that a big file cannot win a long query by volume alone, which is the
 * bug that made `bce_find_context` return an unrelated route table first and
 * bury the file the query actually named.
 */
describe('ranking does not reward volume', () => {
  it('gives extra matches in one file diminishing weight', () => {
    // The first matches keep full weight: several strong symbols in one file is
    // a good hit, not a red flag.
    expect(symbolMatchDecay(0)).toBe(1);
    expect(symbolMatchDecay(1)).toBe(1);
    expect(symbolMatchDecay(2)).toBe(1);
    // Beyond that each further match is worth progressively less...
    expect(symbolMatchDecay(3)).toBeLessThan(1);
    expect(symbolMatchDecay(10)).toBeLessThan(symbolMatchDecay(3));
    // ...but never reaches zero, so a big file can still surface when it is right.
    expect(symbolMatchDecay(1000)).toBeGreaterThan(0);
  });

  it('ranks a file named by the query above a file that merely contains its words', async () => {
    const h = await harness();
    await h.work();
    const bundle = await h.intelligence.retrieve(options({
      query: 'orderService refund storefront checkout basket payment token receipt invoice shipment',
      includeSnippets: false,
      maxResults: 10
    }));
    expect(bundle.items.length).toBeGreaterThan(0);
    // The named service must be first even though the noise words appear in many
    // other files in the fixture.
    expect(bundle.items[0].path).toBe('src/services/orderService.ts');
  });

  it('weights a rare query term above a common one', async () => {
    const h = await harness();
    await h.work();
    // "money" appears in a single utility file; "service" appears in several.
    const rare = await h.intelligence.retrieve(options({ query: 'money', includeSnippets: false }));
    const common = await h.intelligence.retrieve(options({ query: 'service', includeSnippets: false }));
    expect(rare.items[0].path).toBe('src/utils/money.ts');
    expect(rare.items[0].score).toBeGreaterThan(0);
    // The rare hit is a sharper match and should be reported with strictly more
    // confidence in its score than the diluted common-term best hit.
    expect(rare.items[0].score).toBeGreaterThan(common.items[0].score);
  });

  it('keeps the phase-one list short and cheap', async () => {
    const h = await harness();
    await h.work();
    const payload = await runFindContext(h.intelligence, {
      query: 'order user service money report schema route refund invoice payment',
      symbolsOnly: true
    });
    // A shortlist, not an inventory: an agent picks from the top handful.
    expect(payload.quality?.hits ?? 0).toBeLessThanOrEqual(24);
    // And it must stay cheap enough to read directly instead of being spilled to a file.
    expect(payload.text.length).toBeLessThan(6000);
  });

  it('renders phase-one hits without the verbose why and symbol blocks', async () => {
    const h = await harness();
    await h.work();
    const compact = await runFindContext(h.intelligence, { query: 'OrderService refund', symbolsOnly: true });
    const verbose = await runFindContext(h.intelligence, { query: 'OrderService refund' });
    expect(compact.text).not.toContain('   why:');
    expect(compact.text).not.toContain('   code:');
    // Same logical hits, materially less text.
    expect(compact.text.length).toBeLessThan(verbose.text.length);
  });
});
