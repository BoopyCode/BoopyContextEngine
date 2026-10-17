/**
 * Measurement report for a run where the model is real (DeepSeek, OpenAI-compatible).
 *
 * The difference from the mock report is where the numbers come from:
 *  - prompt tokens are the provider's own `usage.prompt_tokens`,
 *  - cached tokens come from `usage.prompt_cache_hit_tokens` (DeepSeek's cache),
 *  - cost is priced from the model's list price in `consts.js`-style numbers supplied here.
 *
 * That makes this the honest end-to-end number: it is what you are billed for.
 */

const PRICE = {
  // USD per 1M tokens, DeepSeek off-peak V4 Flash (as published in the extension registry).
  'deepseek-v4-flash': { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  'deepseek-flash': { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  'deepseek-v4-pro': { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
};

export function priceFor(model) {
  return PRICE[model] ?? PRICE['deepseek-v4-flash'];
}

export function renderLiveReport(report) {
  const { arms } = report;
  const a = arms.a;
  const b = arms.b;
  const price = priceFor(report.model);

  const totals = (arm) => {
    let prompt = 0;
    let cached = 0;
    let completion = 0;
    let toolCalls = 0;
    for (const turn of arm.turns) {
      prompt += turn.usage?.prompt_tokens ?? 0;
      cached += turn.usage?.prompt_cache_hit_tokens ?? 0;
      completion += turn.usage?.completion_tokens ?? 0;
      toolCalls += turn.toolCalls ?? 0;
    }
    const miss = Math.max(0, prompt - cached);
    const cost = (miss / 1e6) * price.cacheMiss + (cached / 1e6) * price.cacheHit + (completion / 1e6) * price.output;
    return { prompt, cached, miss, completion, toolCalls, cost, turns: arm.turns.length };
  };

  const ta = totals(a);
  const tb = totals(b);
  const savings = (x, y) => (x === 0 ? '0%' : `${Math.round((1 - y / x) * 1000) / 10}%`);
  const money = (value) => `$${value.toFixed(4)}`;
  // Plain ASCII separators: `toLocaleString` emits non-breaking spaces, which break tables
  // the moment the markdown is read by anything that is not the machine's locale.
  const num = (value) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const lines = [];
  lines.push(`# Real-model A/B - ${report.label}`);
  lines.push('');
  lines.push(`DeepSeek **${report.model}**, ${report.turns ?? a.turns.length} turns, free-form tool use by the model itself.`);
  lines.push(`Arm A calls DeepSeek directly; arm B goes through Headroom. Same task, same tools, same GitHub snapshot.`);
  lines.push(`Both arms ran at ${report.temperature ?? 'the model\'s default temperature'}.`);
  lines.push('');
  lines.push('## Billed input tokens (provider usage)');
  lines.push('');
  lines.push('| metric | arm A (direct) | arm B (Headroom) | difference |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(`| prompt tokens | ${num(ta.prompt)} | ${num(tb.prompt)} | **${savings(ta.prompt, tb.prompt)} fewer** |`);
  lines.push(`| of which cache hits | ${num(ta.cached)} | ${num(tb.cached)} | |`);
  lines.push(`| cache misses (full price) | ${num(ta.miss)} | ${num(tb.miss)} | ${savings(ta.miss, tb.miss)} |`);
  lines.push(`| completion tokens | ${num(ta.completion)} | ${num(tb.completion)} | ${savings(ta.completion, tb.completion)} |`);
  lines.push(`| **list cost** | **${money(ta.cost)}** | **${money(tb.cost)}** | **${savings(ta.cost, tb.cost)} cheaper** |`);
  lines.push(`| tool calls made by the model | ${ta.toolCalls} | ${tb.toolCalls} | |`);
  lines.push('');
  lines.push('## Per turn');
  lines.push('');
  lines.push('| # | A prompt | A cache hit | B prompt | B cache hit | A tools | B tools |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | --- | --- |');
  const turns = Math.max(a.turns.length, b.turns.length);
  for (let index = 0; index < turns; index += 1) {
    const left = a.turns[index] ?? {};
    const right = b.turns[index] ?? {};
    lines.push(
      `| ${index + 1} | ${left.usage?.prompt_tokens ?? '-'} | ${left.usage?.prompt_cache_hit_tokens ?? '-'} | ${right.usage?.prompt_tokens ?? '-'} | ${right.usage?.prompt_cache_hit_tokens ?? '-'} | ${(left.tools ?? []).join(', ') || '-'} | ${(right.tools ?? []).join(', ') || '-'} |`
    );
  }
  lines.push('');
  lines.push('## Answers');
  lines.push('');
  lines.push(`- arm A: ${a.answer ? `"${a.answer.slice(0, 400).replace(/\s+/g, ' ')}${a.answer.length > 400 ? '...' : ''}"` : '(no answer recorded)'}`);
  lines.push(`- arm B: ${b.answer ? `"${b.answer.slice(0, 400).replace(/\s+/g, ' ')}${b.answer.length > 400 ? '...' : ''}"` : '(no answer recorded)'}`);
  lines.push('');
  if (report.headroom?.transforms?.length) {
    lines.push('## What Headroom did');
    lines.push('');
    lines.push('| transform | requests |');
    lines.push('| --- | ---: |');
    for (const transform of report.headroom.transforms) {
      lines.push(`| \`${transform.name}\` | ${transform.count} |`);
    }
    lines.push('');
  }
  lines.push('## What this measures and what it does not');
  lines.push('');
  lines.push('- These are **provider-billed** prompt tokens, not an estimate. That is the strongest number this');
  lines.push('  test can produce, and it already includes DeepSeek\'s own prefix caching in both arms.');
  lines.push('- The model is allowed to choose its own tool calls, so the two arms can take different paths. Read');
  lines.push('  the per-turn table before quoting the total: a longer conversation in one arm is a task difference,');
  lines.push('  not a compression effect.');
  lines.push('- The answers are shown verbatim above so you can judge whether compression changed the result.');
  lines.push('');
  return lines.join('\n');
}
