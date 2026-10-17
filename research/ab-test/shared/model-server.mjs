/**
 * One static mock model, two entry ports.
 *
 * The A/B test must not let arm A and arm B race on live GitHub data, and the mock model
 * must see the *post-compression* body in both arms (Headroom never calls back into the
 * test process). So the mock listens on two ports:
 *
 *   :8811  <- arm A's recording proxy forwards here directly
 *   :8812  <- Headroom (arm B) sends its compressed body here
 *
 * Both ports run the exact same handler: parse the body, count prompt tokens with
 * tiktoken, append a line with the port and the measurement, answer with a stable
 * OpenAI-shaped reply. Nothing here decides tool calls.
 */

import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import tiktoken from 'tiktoken';

const directPort = Number(process.argv[2] ?? 8811);
const compressedPort = Number(process.argv[3] ?? 8812);
const logFile = process.argv[4];

let encoder;
function tokens(text) {
  if (!encoder) encoder = tiktoken.get_encoding('cl100k_base');
  return encoder.encode(text).length;
}

if (logFile) writeFileSync(logFile, '');

function handle(port) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let promptTokens = 0;
      let toolResults = 0;
      let userText = '';
      try {
        const body = JSON.parse(raw);
        promptTokens = tokens(JSON.stringify(body.messages ?? []));
        toolResults = (body.messages ?? []).filter((message) => message.role === 'tool').length;
        userText = (body.messages ?? [])
          .filter((message) => message.role === 'user')
          .map((message) => message.content)
          .join(' ');
      } catch {
        promptTokens = tokens(raw);
      }
      if (logFile) {
        appendFileSync(
          logFile,
          JSON.stringify({ at: Date.now(), port, bytesIn: Buffer.byteLength(raw), promptTokens, toolResults, userText: userText.slice(0, 120) }) + '\n'
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens }
        })
      );
    });
  };
}

http.createServer(handle(directPort)).listen(directPort, '127.0.0.1', () => console.log(`mock model (direct) on ${directPort}`));
http.createServer(handle(compressedPort)).listen(compressedPort, '127.0.0.1', () => console.log(`mock model (via headroom) on ${compressedPort}`));
