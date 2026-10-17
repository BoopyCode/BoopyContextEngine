/**
 * A stand-in DeepSeek endpoint (streaming, OpenAI-compatible) for verifying the live
 * harness without spending money or needing a key.
 *
 *   node ab-test/shared/fake-deepseek.mjs [port]
 *
 * It emits a realistic two-turn trajectory: one tool call, then an answer, both streamed
 * as SSE with a `usage` block that includes `prompt_cache_hit_tokens` like DeepSeek does.
 * The prompt tokens are counted with tiktoken on what actually arrived, so pointing the
 * real harness at this server measures the same thing the paid run measures.
 */

import http from 'node:http';
import tiktoken from 'tiktoken';

const port = Number(process.argv[2] ?? 8820);
let encoder;
const tokens = (text) => {
  if (!encoder) encoder = tiktoken.get_encoding('cl100k_base');
  return encoder.encode(text).length;
};

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // fall through with an empty body
    }
    const messages = body.messages ?? [];
    const prompt = tokens(JSON.stringify(messages));
    const toolResults = messages.filter((message) => message.role === 'tool').length;
    const toolNames = new Set(
      messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => (message.tool_calls ?? []).map((call) => call.function?.name))
    );

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant' } }] }));

    if (toolResults === 0) {
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'github_search', arguments: '{"query":"interesting","perQuery":4}' } }] }
            }
          ]
        })
      );
      res.write(sse({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: 18, prompt_cache_hit_tokens: 0 } }));
    } else if (!toolNames.has('summarize_results')) {
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'summarize_results', arguments: '{}' } }] }
            }
          ]
        })
      );
      res.write(sse({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: 12, prompt_cache_hit_tokens: 0 } }));
    } else {
      res.write(sse({ choices: [{ index: 0, delta: { content: 'Recommendation: (1) the top-scoring repo, (2) the trending keyword match, (3) the runner-up.' } }] }));
      res.write(sse({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: 24, prompt_cache_hit_tokens: 0 } }));
    }
    if (body.stream_options?.include_usage !== true) {
      process.stderr.write('fake-deepseek: client did not ask for stream usage\n');
    }
    res.end('data: [DONE]\n\n');
  });
});

server.listen(port, '127.0.0.1', () => console.log(`fake DeepSeek (SSE) on 127.0.0.1:${port}`));
