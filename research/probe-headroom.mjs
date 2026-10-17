/**
 * Probes the local Headroom proxy with the payload shapes BCE actually returns,
 * so the integration is measured against real traffic rather than the README table.
 *
 * Usage: node scripts/probe-headroom.mjs [url]
 */

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

const samples = buildSamples();

async function main() {
  let exitCode = 0;
  try {
    const health = await get('/health');
    console.log(`health: ${health.status} ${health.version ?? ''}`.trim());
  } catch (error) {
    console.error(`proxy unreachable at ${baseUrl}: ${error.message}`);
    process.exit(1);
  }
  for (const sample of samples) {
    const started = Date.now();
    try {
      const result = await compress(sample.text);
      const elapsed = Date.now() - started;
      const after = result.messages?.at(-1)?.content;
      const beforeTokens = result.tokens_before ?? 0;
      const afterTokens = result.tokens_after ?? 0;
      const identical = after === sample.text;
      const saved = beforeTokens > 0 ? Math.round((1 - afterTokens / beforeTokens) * 100) : 0;
      console.log(
        `${sample.name.padEnd(28)} ${String(beforeTokens).padStart(6)} -> ${String(afterTokens).padStart(6)} tokens (${String(saved).padStart(3)}%), ` +
          `${identical ? 'byte-identical' : 'rewritten'}, ${elapsed} ms, transforms: ${(result.transforms_applied ?? []).join(',') || 'none'}`
      );
    } catch (error) {
      exitCode = 1;
      console.log(`${sample.name.padEnd(28)} failed: ${error.message}`);
    }
  }
  process.exit(exitCode);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}`);
  }
  return response.json();
}

async function compress(text) {
  const response = await fetch(`${baseUrl}/v1/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Headroom-Stack': 'bce' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: text }],
      model: 'gpt-4o',
      config: { compress_user_messages: true, protect_recent: 0 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function buildSamples() {
  const headers = Array.from({ length: 40 }, (_, index) => ({
    time: `2026-10-17T09:${String(index).padStart(2, '0')}:00Z`,
    level: index % 7 === 0 ? 'ERROR' : 'INFO',
    service: ['api', 'worker', 'scheduler'][index % 3],
    requestId: `req-${1000 + index}`,
    message: index % 7 === 0 ? 'database connection retry scheduled' : 'request completed',
    durationMs: 12 + (index % 5)
  }));
  const jsonBlock = `recent log records:\n${JSON.stringify(headers, null, 2)}`;

  const searchRows = Array.from({ length: 40 }, (_, index) => ({
    id: `doc-${index}`,
    path: `src/core/module-${index % 6}/file-${index}.ts`,
    score: Number((0.9 - index * 0.01).toFixed(3)),
    kind: index % 2 === 0 ? 'function' : 'class'
  }));
  const searchBlock = `search results:\n${JSON.stringify(searchRows, null, 2)}`;

  const prose = Array.from(
    { length: 40 },
    (_, index) =>
      `Step ${index + 1}: the worker restarts the queue consumer, reconnects to the broker and logs the recovery. The consumer keeps its offset so no message is read twice.`
  ).join('\n');
  const proseBlock = `runbook for the queue consumer\n${prose}`;

  const code = `export function estimate(text: string): number {\n${Array.from(
    { length: 40 },
    (_, index) => `  const part${index} = text.slice(${index}, ${index + 1});`
  ).join('\n')}\n  return text.length / 4;\n}`;
  const codeSlice = `provenance: computed now\nnext: open only the listed ranges\n\nsrc/core/util/tokens.ts:1-43\n\`\`\`ts\n${code}\n\`\`\``;

  const short = 'index scope: 120 file(s) indexed\ncoverage: 100% of internal imports linked';

  return [
    { name: 'json log records (~40 rows)', text: jsonBlock },
    { name: 'json search results (~40 rows)', text: searchBlock },
    { name: 'plain prose (~900 tokens)', text: proseBlock },
    { name: 'BCE rendered slice + code', text: codeSlice },
    { name: 'short payload', text: short }
  ];
}

main();
