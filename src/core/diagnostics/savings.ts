import { BceToolName } from '../tools/toolTypes';
import { WorkspaceIntelligence } from '../workspace';
import { estimateNaiveBaseline } from '../benchmark/baseline';

export interface UsageSavings {
  label?: string;
  /** Estimated tokens of the naive alternative, when the tool has a defensible one. */
  baselineTokens?: number;
  baselineFiles?: number;
  candidateFiles?: number;
  /** Ranked hits that survived the token budget; 0 means the query found nothing. */
  hits?: number;
  /** True when the token budget cut the result short. */
  truncated?: boolean;
  /** True when snippets came from an unsaved editor buffer. */
  dirty?: boolean;
}

/**
 * Describes one tool call for the usage log: what was asked and - where it is meaningful -
 * what the same question would have cost the naive way.
 *
 * Baseline policy, deliberately conservative:
 * * `bce_find_context` - reading every file whose path or symbol names match a query term.
 * * `bce_get_file_context` - reading that whole file instead of the requested symbol.
 * * everything else - no baseline, because there is no honest "without BCE" equivalent
 *   (the overview, impact and related-tests tools replace searching plus reading).
 */
export function estimateUsageSavings(
  ws: WorkspaceIntelligence,
  tool: BceToolName,
  input: unknown,
  quality?: { hits: number; truncated: boolean; dirty: boolean }
): UsageSavings {
  const raw = (input ?? {}) as Record<string, unknown>;

  if (tool === 'bce_find_context') {
    const query = typeof raw.query === 'string' ? raw.query : '';
    const baseline = estimateNaiveBaseline(ws.index, query);
    return {
      label: query,
      baselineTokens: baseline.estimatedTokens,
      baselineFiles: baseline.files,
      candidateFiles: ws.index.size,
      hits: quality?.hits,
      truncated: quality?.truncated,
      dirty: quality?.dirty
    };
  }

  if (tool === 'bce_get_file_context') {
    const target = typeof raw.path === 'string' ? raw.path : '';
    const symbol = typeof raw.symbol === 'string' ? raw.symbol : undefined;
    const file = ws.index.get(target);
    return {
      label: symbol ? `${target}#${symbol}` : target,
      baselineTokens: file ? Math.round(file.size / 4) : undefined,
      baselineFiles: file ? 1 : undefined
    };
  }

  if (tool === 'bce_explain_impact') {
    const target = typeof raw.path === 'string' ? raw.path : typeof raw.symbol === 'string' ? raw.symbol : '';
    return { label: target };
  }

  if (tool === 'bce_get_related_tests') {
    const target = typeof raw.path === 'string' ? raw.path : typeof raw.symbol === 'string' ? raw.symbol : '';
    return { label: target };
  }

  if (tool === 'bce_get_project_overview') {
    const focus = typeof raw.focus === 'string' ? raw.focus : undefined;
    return { label: focus ? `focus: ${focus}` : 'whole project' };
  }

  return { label: raw.verbose === true ? 'verbose' : undefined };
}
