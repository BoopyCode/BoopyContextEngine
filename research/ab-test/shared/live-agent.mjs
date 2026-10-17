/**
 * Real-model agent loop (DeepSeek, OpenAI-compatible chat completions).
 *
 * Unlike `agent.mjs`, the model here *does* choose the tool calls, which is what makes
 * this an end-to-end test: the same task runs twice and the only injected difference is
 * whether the request goes through Headroom.
 *
 * Safety rails: a tool budget cap and a per-turn token cap, so a confused model cannot
 * run up an unbounded bill. Nothing is written outside the repo.
 */

import { TOOLS, runTool } from '../app/tools.mjs';

const SYSTEM =
  'You are a coding agent working on a GitHub scout application. ' +
  'Use the tools to find and evaluate interesting repositories, then answer with three concrete recommendations and why.';

const TASK =
  'Find interesting repositories for an AI-agent tooling side project. ' +
  'Search at least twice, look at details of the top result, and summarize what you found. ' +
  'Then read app/githubScout.mjs and say which part of the scoring you would change first. Be concise.';

/**
 * Collects an SSE chat-completion stream into one assistant message plus its usage block.
 * Mirrors what the DeepSeek extension does: tool-call deltas are accumulated by index and
 * emitted when the stream finishes.
 */
async function readStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage;
  const calls = new Map();

  const handle = (payload) => {
    if (payload.usage) {
      usage = payload.usage;
    }
    const choice = payload.choices?.[0];
    const delta = choice?.delta;
    if (!delta) {
      return;
    }
    if (typeof delta.content === 'string') {
      content += delta.content;
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.size;
      const current = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      calls.set(index, current);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === '[DONE]' || data.length === 0) {
        continue;
      }
      try {
        handle(JSON.parse(data));
      } catch {
        // A partial or non-JSON event is ignored; the stream is still usable.
      }
    }
  }

  return {
    content,
    usage,
    tool_calls: [...calls.values()].filter((call) => call.function.name.length > 0)
  };
}

export async function runLiveAgent({
  endpoint,
  apiKey,
  model,
  snapshot,
  maxSteps = 10,
  maxTokens = 1200,
  temperature
}) {
  const state = { snapshot };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: TASK }
  ];
  const turns = [];
  let answer = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const body = {
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: temperature ?? 0.2,
      max_tokens: maxTokens,
      // Same as the DeepSeek VS Code extension: stream, and ask for usage in the stream.
      stream: true,
      stream_options: { include_usage: true }
    };
    const started = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    if (!response.ok) {
      throw new Error(`model HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const message = await readStream(response);
    const toolCalls = message.tool_calls ?? [];

    turns.push({
      step,
      ms: Date.now() - started,
      usage: message.usage,
      tools: toolCalls.map((call) => call.function?.name).filter(Boolean),
      toolCalls: toolCalls.length
    });

    if (toolCalls.length === 0) {
      answer = message.content ?? '';
      break;
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments ?? '{}');
      } catch {
        args = {};
      }
      const result = await runTool(state, call.function?.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }

  return {
    turns,
    messages: messages.length,
    answer,
    usedTools: [...new Set(turns.flatMap((turn) => turn.tools))]
  };
}
