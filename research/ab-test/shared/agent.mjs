/**
 * The agent loop. Deterministic and identical in both A/B arms.
 *
 * Only `endpoint` varies: arm A posts to a recording proxy that forwards to the mock
 * model, arm B posts to a recording proxy that forwards to Headroom. Both record exact
 * request bytes; the mock model records the prompt tokens that actually arrived.
 *
 * Tools read from one fixed GitHub snapshot, so the arms cannot diverge on data.
 */

import tiktoken from 'tiktoken';
import { TOOLS, runTool } from '../app/tools.mjs';

let encoder;
function countTokens(text) {
  if (!encoder) encoder = tiktoken.get_encoding('cl100k_base');
  return encoder.encode(text).length;
}

/** The fixed trajectory: explore -> drill in -> another query -> summarise -> read code. */
const PLAN = [
  () => ({ name: 'github_search', args: { query: 'interesting', perQuery: 8, enrichTop: 4 } }),
  () => ({ name: 'repo_details', args: { rank: 0 } }),
  () => ({ name: 'github_search', args: { query: 'agents', perQuery: 6, enrichTop: 3 } }),
  () => ({ name: 'summarize_results', args: {} }),
  () => ({ name: 'read_file', args: { path: 'app/githubScout.mjs' } }),
  () => ({ name: 'read_file', args: { path: 'app/agent.mjs' } }),
  () => ({ name: 'summarize_results', args: {} })
];

export async function runAgentLoop({ endpoint, snapshot, rounds = 1 }) {
  const state = { snapshot };
  const messages = [
    {
      role: 'system',
      content: 'You are a coding agent working on a GitHub scout application. Use the tools to find and evaluate interesting repositories, then answer.'
    },
    {
      role: 'user',
      content:
        'Find interesting repositories for an AI-agent tooling side project. Look at the top results, read the scoring code, and recommend three with reasons.'
    }
  ];
  const turns = [];

  // `rounds` repeats the request on the same growing conversation, which is what a real
  // agent session looks like: every turn re-sends all prior tool output.
  const steps = PLAN.length * rounds;
  for (let step = 0; step < steps; step += 1) {
    const action = PLAN[step % PLAN.length]();
    const body = { model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto', stream: false };
    const sent = JSON.stringify(body);
    const started = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ab-test' },
      body: sent,
      signal: AbortSignal.timeout(600_000)
    });
    if (!response.ok) {
      throw new Error(`endpoint HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const reply = await response.json();
    turns.push({
      step,
      tool: action.name,
      messages: messages.length,
      sentBytes: Buffer.byteLength(sent),
      sentTokens: countTokens(sent),
      modelPromptTokens: reply.usage?.prompt_tokens ?? 0,
      ms: Date.now() - started
    });

    const id = `call_${step}_${action.name}`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }]
    });
    const result = await runTool(state, action.name, action.args);
    messages.push({ role: 'tool', tool_call_id: id, content: result.text });
  }

  // The final turn has no tool to call: the agent answers from what it has.
  const finalBody = { model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto', stream: false };
  const finalSent = JSON.stringify(finalBody);
  const finalStarted = Date.now();
  const finalResponse = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ab-test' },
    body: finalSent,
    signal: AbortSignal.timeout(600_000)
  });
  const finalReply = await finalResponse.json();
  turns.push({
    step: steps,
    tool: 'answer',
    messages: messages.length,
    sentBytes: Buffer.byteLength(finalSent),
    sentTokens: countTokens(finalSent),
    modelPromptTokens: finalReply.usage?.prompt_tokens ?? 0,
    ms: Date.now() - finalStarted
  });

  const toolOutputs = messages.filter((message) => message.role === 'tool');
  const answer =
    'Recommendation: (1) the highest-scoring agent-tooling repository - fresh, well documented, focused topics; ' +
    '(2) the strongest trending-keyword match from the second search; (3) the best-maintained runner-up. Scores are in the ranked list.';
  messages.push({ role: 'assistant', content: answer });

  return {
    turns,
    messages: messages.length,
    toolResults: toolOutputs.length,
    toolOutputBytes: toolOutputs.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0),
    toolOutputTokens: toolOutputs.reduce((sum, message) => sum + countTokens(message.content), 0),
    usedTools: [...new Set(messages.filter((message) => message.role === 'assistant').flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name)))],
    answer
  };
}
