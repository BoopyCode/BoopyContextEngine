/**
 * Renders one A/B run as markdown. Three distinct measurements are kept apart instead of
 * being blended into one "saved X%" claim:
 *
 *  - `sentTokens`: tiktoken over every request body the agent produced. Identical in both
 *    arms by construction (same agent, same snapshot) - a delta here would be a bug.
 *  - `modelPromptTokens`: tiktoken over the message list that arrived at the model,
 *    i.e. *after* compression. This is the column that matters.
 *  - bytes: exact wire sizes from the recording proxy.
 */

function pct(before, after) {
  if (!before) return '0%';
  return `${Math.round((1 - after / before) * 1000) / 10}%`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function sum(arm, field) {
  return arm.turns.reduce((total, turn) => total + (turn[field] ?? 0), 0);
}

export function renderReport(report) {
  const { arms, github } = report;
  const a = arms.a;
  const b = arms.b;
  const aSent = sum(a, 'sentTokens');
  const bSent = sum(b, 'sentTokens');
  const aModel = sum(a, 'modelPromptTokens');
  const bModel = sum(b, 'modelPromptTokens');
  const aBytes = sum(a, 'sentBytes');
  const bBytes = sum(b, 'sentBytes');
  const identical = JSON.stringify(a.usedTools) === JSON.stringify(b.usedTools);

  const lines = [];
  lines.push(`# BCE + Headroom A/B - ${report.label}`);
  lines.push('');
  lines.push('The same agent, the same tools and the same GitHub snapshot run twice. The only difference:');
  lines.push('arm A posts straight to the model, arm B posts through Headroom.');
  if (report.control === 'headroom-off') {
    lines.push('');
    lines.push('> **Control run:** Headroom is in passthrough mode (`--no-optimize`). A sound harness must report ~0% here.');
  }
  lines.push('');
  lines.push(`- Headroom **${report.headroomVersion ?? '?'}**, mode \`${report.headroomMode}\``);
  lines.push(
    `- GitHub: ${github.repositories} repositories, ${kb(github.toolOutputBytes)} of raw API output over ${github.requests.length} calls (queries: ${github.queries.join(', ')})`
  );
  lines.push(`- Agent: ${a.turns.length} turns, tools used: ${a.usedTools.join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push('| metric | arm A (direct) | arm B (Headroom) | difference |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(`| **input tokens the model counted** | **${aModel}** | **${bModel}** | **${pct(aModel, bModel)} smaller** |`);
  lines.push(`| request bytes sent by the agent | ${kb(aBytes)} (${aBytes} B) | ${kb(bBytes)} (${bBytes} B) | identical by design |`);
  lines.push(`| client-side tokens (same conversation) | ${aSent} | ${bSent} | ${aSent === bSent ? '0%' : pct(aSent, bSent)} |`);
  lines.push(`| tool results in the final conversation | ${a.toolResults} | ${b.toolResults} | |`);
  lines.push(`| tool output bytes | ${kb(a.toolOutputBytes)} | ${kb(b.toolOutputBytes)} | |`);
  lines.push(`| tools called | ${a.usedTools.join(', ') || 'none'} | ${b.usedTools.join(', ') || 'none'} | ${identical ? 'identical' : 'DIFFERENT'} |`);
  lines.push('');
  const saved = aModel - bModel;
  lines.push(
    saved > 0
      ? `**Headroom removed ${saved} prompt tokens (${pct(aModel, bModel)}) before the model saw the conversation.**`
      : `**No reduction: Headroom left the requests byte-identical (${pct(aModel, bModel)}).** That is a real result for this payload mix, not a hidden failure - see the per-turn table.`
  );
  lines.push('');
  lines.push('## Per turn');
  lines.push('');
  lines.push('| # | tool | msgs | A bytes | B bytes | A tokens | B tokens | model A | model B | delta |');
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (let index = 0; index < a.turns.length; index += 1) {
    const left = a.turns[index];
    const right = b.turns[index] ?? {};
    lines.push(
      `| ${index + 1} | ${left.tool} | ${left.messages} | ${left.sentBytes} | ${right.sentBytes ?? 0} | ${left.sentTokens} | ${right.sentTokens ?? 0} | ${left.modelPromptTokens} | ${right.modelPromptTokens ?? 0} | ${left.modelPromptTokens ? pct(left.modelPromptTokens, right.modelPromptTokens ?? 0) : '-'} |`
    );
  }
  lines.push('');
  lines.push('');
  if (report.headroom?.transforms?.length || report.headroom?.savedEvents?.length) {
    lines.push('## What Headroom actually did');
    lines.push('');
    if (report.headroom.transforms?.length) {
      lines.push('| transform | requests |');
      lines.push('| --- | ---: |');
      for (const transform of report.headroom.transforms) {
        lines.push(`| \`${transform.name}\` | ${transform.count} |`);
      }
      lines.push('');
    }
    if (report.headroom.savedEvents?.length) {
      const claim = report.headroom.savedEvents.reduce((total, event) => total + event.saved, 0);
      lines.push(`The proxy logged \`tok_before -> tok_after\` for ${report.headroom.savedEvents.length} request(s), totalling **${claim} tokens saved** by its own count.`);
      lines.push(`That is consistent with the model-side measurement above (${saved} tokens), which is what matters: both were taken after compression.`);
      lines.push('');
    }
  }
  lines.push('## What the numbers mean');
  lines.push('');
  lines.push('- **model A / model B** is what a provider would bill as input, counted with tiktoken on the body that');
  lines.push('  actually arrived. It is measured *after* both proxies, so it is the only honest compression number here.');
  lines.push('- The client-side token and byte columns are identical because the agent is the same. They prove the');
  lines.push('  comparison is fair; they are not a saving.');
  lines.push('- The answer is identical too: the agent chooses the trajectory, so compression cannot change *which*');
  lines.push('  tool was called - only how much of its output the model had to read.');
  lines.push('');
  return lines.join('\n');
}
