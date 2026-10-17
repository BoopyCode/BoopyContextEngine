/**
 * The DeepSeek VS Code extension's exact contract, run through the real BCE transport.
 *
 * The extension (`vizards.deepseek-v4-for-copilot`) does:
 *   POST `${baseUrl}/chat/completions`
 *   with  stream: true, stream_options: { include_usage: true }
 * and reads SSE deltas back.
 *
 * This script stands in for that extension: it points `baseUrl` at the transport endpoint
 * and hits it with the same shape. A fake DeepSeek behind the transport answers; the
 * assertion is that the extension-style request survives the hop and comes back streamed.
 *
 *   node ab-test/check-vscode-path.mjs [upstreamPort]
 */

import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const upstreamPort = Number(process.argv[2] ?? 8820);
const transportPort = 8789;

// Bundle the transport module standalone: the shipped extension does not export it, and
// exposing internals just for a test would be the wrong trade.
const esbuild = await import('esbuild');
const outfile = join(root, '.transport-check.mjs');
await esbuild.build({
  entryPoints: [join(root, 'src', 'core', 'transport', 'transport.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
});
const bundle = await import('file:///' + outfile.replaceAll('\\', '/'));
const Transport = bundle.Transport;
if (!Transport) {
  console.error('The bundled transport does not export Transport.');
  process.exit(2);
}

const seen = [];
const transport = new Transport(
  { mode: 'cache', port: transportPort, command: '', idleStopMinutes: 20, startupTimeoutMs: 15000, maxBodyBytes: 8 << 20, manageProxy: false },
  {
    log: (level, message) => seen.push(`${level}: ${message}`),
    upstream: () => `http://127.0.0.1:${upstreamPort}`,
    onOverride: async (url) => {
      seen.push(`override=${url ?? '(cleared)'}`);
      return { ok: true };
    },
    resolveCommand: () => undefined
  },
  root
);
transport.proxyProbed = true;
await transport.start();
const endpoint = `${transport.status().url}/chat/completions`;

// Exactly what the extension sends.
const body = {
  model: 'deepseek-chat',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Find interesting repositories and recommend three.' }
  ],
  tools: [{ type: 'function', function: { name: 'github_search', description: 'search', parameters: { type: 'object', properties: {} } } }],
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true }
};

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer deepseek-vscode-key' },
  body: JSON.stringify(body)
});
const text = await response.text();

console.log(`endpoint:        ${endpoint}`);
console.log(`status:          ${response.status}`);
console.log(`content-type:    ${response.headers.get('content-type')}`);
console.log(`access-control:  ${response.headers.get('access-control-allow-origin')}`);
console.log(`sse chunks:      ${(text.match(/^data:/gm) ?? []).length}`);
console.log(`has tool call:   ${text.includes('github_search')}`);
console.log(`transport stats: ${JSON.stringify(transport.status().stats)}`);
await transport.stop();
console.log('override lifecycle:', seen.filter((line) => line.startsWith('override=')).join(' -> '));

const ok = response.status === 200 && text.includes('data:') && text.includes('github_search');
console.log(ok ? 'RESULT: the extension-style request survives the transport unchanged' : 'RESULT: FAILED');
http.globalAgent.destroy();
process.exit(ok ? 0 : 1);
