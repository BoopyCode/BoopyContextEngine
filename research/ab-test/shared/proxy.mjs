/**
 * Recording proxy for the A/B test.
 *
 * Arm A (`--upstream direct`): the agent talks to this proxy, which forwards every
 * request unchanged to the model. Records exact request bytes.
 *
 * Arm B (`--upstream headroom`): the same proxy forwards to a Headroom proxy instead.
 * Identical client code, identical bodies - the only difference is where the bytes go.
 *
 * Every request/response is appended to runs/<run>/requests.jsonl so the report can
 * attribute bytes per call rather than per run.
 */

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, [])
);

const port = Number(args.port ?? 8810);
const upstream = args.upstream === 'headroom' ? args.headroomUrl ?? 'http://127.0.0.1:8787' : args.modelUrl;
const logFile = args.log;
if (logFile) mkdirSync(dirname(logFile), { recursive: true });

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const path = upstream.endsWith('/v1') || upstream.includes('/v1/')
      ? `${upstream.replace(/\/+$/, '')}${req.url}`
      : `${upstream.replace(/\/+$/, '')}${req.url}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    headers['content-type'] = 'application/json';
    if (args.stack) headers['x-headroom-stack'] = args.stack;

    const started = Date.now();
    try {
      const response = await fetch(path, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
        signal: AbortSignal.timeout(600000)
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      let parsed;
      try {
        parsed = JSON.parse(responseBody.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      if (logFile) {
        appendFileSync(
          logFile,
          JSON.stringify({
            at: Date.now(),
            path: req.url,
            sentBytes: body.length,
            receivedBytes: responseBody.length,
            status: response.status,
            ms: Date.now() - started,
            upstream,
            usage: parsed?.usage,
            headroom: parsed?.headroom ?? response.headers.get('x-headroom-compressed') ?? undefined
          }) + '\n'
        );
      }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(responseBody);
    } catch (error) {
      if (logFile) {
        appendFileSync(logFile, JSON.stringify({ at: Date.now(), path: req.url, sentBytes: body.length, error: String(error), upstream }) + '\n');
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `recording proxy: ${error}`, type: 'proxy_error' } }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`recording proxy :${port} -> ${upstream}${logFile ? ` (log ${logFile})` : ''}`);
});
