/**
 * Reads Headroom's per-request log line so the report can say *what* changed, not just
 * how much:
 *
 *   [hr_...] gpt-4o: 6,814 → 5,629 (saved 1,185 tokens)
 *   ... transforms=router:mixed:0.48
 *   Pipeline complete: 6877 -> 6796 tokens (saved 81, 1.2% reduction)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PERF = /PERF model=(\S+) msgs=(\d+) tok_before=(\d+) tok_after=(\d+) tok_saved=(\d+)/;
const TRANSFORMS = /transforms=(\S+)\s*$/;
const SAVED = /\[(hr_[^\]]+)\]\s+(\S+):\s+([\d,]+)\s+→\s+([\d,]+)\s+\(saved\s+([\d,]+)\s+tokens\)/;

/**
 * "Name of the last pipe-separated field", without guessing which separators the router
 * uses: `router:openai:responses:function_call_output:mixed` -> `function_call_output`,
 * `router:mixed:0.48` -> `mixed`, `router:responses_cross_turn_dedup` -> that name.
 */
export function transformName(value) {
  const parts = value.split(':').filter((part) => part.length > 0 && /[A-Za-z]/.test(part) && !/^[\d.]+$/.test(part));
  return parts[parts.length - 1] ?? value;
}

export function readCompressionLog(port = 8787, sinceMs = 0) {
  const path = join(homedir(), '.headroom', 'logs', `proxy-${port}.log`);
  if (!existsSync(path)) {
    return { path, events: [] };
  }
  const events = [];
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    // The log file survives restarts, so only events from this run may be counted.
    const stamp = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+)/);
    if (stamp && Date.parse(stamp[1].replace(',', '.')) < sinceMs) {
      continue;
    }
    const perf = PERF.exec(line);
    const saved = SAVED.exec(line);
    if (perf) {
      const transforms = TRANSFORMS.exec(line);
      events.push({
        kind: 'perf',
        request: (line.match(/\[(hr_[^\]]+)\]/) ?? [])[1],
        model: perf[1],
        messages: Number(perf[2]),
        before: Number(perf[3]),
        after: Number(perf[4]),
        saved: Number(perf[5]),
        transforms: transforms ? transforms[1].trim().split(/\s+/).filter(Boolean) : []
      });
    } else if (saved) {
      events.push({
        kind: 'saved',
        request: saved[1],
        model: saved[2],
        before: Number(saved[3].replaceAll(',', '')),
        after: Number(saved[4].replaceAll(',', '')),
        saved: Number(saved[5].replaceAll(',', ''))
      });
    }
  }
  return { path, events };
}

/** Groups the transforms that actually ran, so the report can name the mechanism. */
export function transformBreakdown(events) {
  const counts = new Map();
  // Prefer the PERF lines: they carry the final `transforms=` field. The "saved" summary
  // lines are kept for their token totals only.
  for (const event of events.filter((entry) => entry.kind === 'perf')) {
    for (const transform of event.transforms ?? []) {
      const name = transformName(transform);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
