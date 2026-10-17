/**
 * The agent's tool surface for the A/B test.
 *
 * Mirrors the tools a coding agent uses (search, read, bash), so the conversation the
 * model receives has the same shape: a growing pile of tool outputs. All GitHub data comes
 * from one snapshot captured before either arm runs, so the two arms are comparable.
 */

import { scoreRepository } from './githubScout.mjs';

const FILES = {
  'app/githubScout.mjs': 'GitHub search + scoring module (the file the task is about).',
  'app/agent.mjs': 'Agent loop: model call, tool dispatch, conversation growth.',
  'shared/metrics.mjs': 'Token accounting shared by both A/B arms.',
  'shared/proxy.mjs': 'The recording proxy: the only difference between arm A and arm B.'
};

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_search',
      description: 'Search the captured GitHub snapshot for repositories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A preset name (interesting, agents, ts, rust) or the raw query.' },
          perQuery: { type: 'number' },
          enrichTop: { type: 'number' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_details',
      description: 'Full details and scoring breakdown for one repository from the last search.',
      parameters: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          rank: { type: 'number', description: 'Index in the last ranked list (0 = best).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a project file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'summarize_results',
      description: 'Aggregate the last search into language and keyword statistics.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

export async function runTool(state, name, args) {
  switch (name) {
    case 'github_search': {
      const result = searchSnapshot(state.snapshot, String(args.query ?? 'interesting'), args.perQuery);
      state.lastSearch = result;
      return { text: JSON.stringify(result, null, 2) };
    }
    case 'repo_details': {
      const list = state.lastSearch?.ranked ?? [];
      const target = typeof args.full_name === 'string'
        ? list.find((repo) => repo.full_name === args.full_name)
        : list[Number(args.rank ?? 0)];
      if (!target) {
        return { text: `Not found in the last search. Available: ${list.map((repo) => repo.full_name).join(', ')}` };
      }
      const detail = state.snapshot.enriched[target.full_name] ?? { languages: {}, tags: [], commits: [] };
      const rescored = scoreRepository(
        { stargazers_count: target.stars, forks_count: 1, open_issues_count: 1, topics: [] },
        { readme: 'x'.repeat(target.readmeBytes), tags: detail.tags ?? [], commits: detail.commits ?? [], languages: detail.languages ?? {} }
      );
      return { text: JSON.stringify({ ...target, languages: detail.languages, tags: detail.tags, commits: detail.commits, rescored }, null, 2) };
    }
    case 'read_file': {
      const content = FILES[args.path];
      if (!content) {
        return { text: `File not found: ${args.path}. Available: ${Object.keys(FILES).join(', ')}` };
      }
      const body = Array.from({ length: 80 }, (_, line) => `// ${line + 1}: ${content}`).join('\n');
      return { text: `--- ${args.path} (80 lines) ---\n${body}` };
    }
    case 'summarize_results': {
      if (!state.lastSearch) {
        return { text: 'No search yet. Call github_search first.' };
      }
      return { text: JSON.stringify(state.lastSearch.summary, null, 2) };
    }
    default:
      return { text: `Unknown tool: ${name}` };
  }
}

/** Returns one query's slice of the captured snapshot, as the live tool would have. */
export function searchSnapshot(snapshot, query, perQuery) {
  const bucket = snapshot.queries[query] ?? snapshot.queries.interesting;
  const limit = Math.min(10, Number(perQuery ?? 6));
  return {
    query: snapshot.queries[query] ? query : 'interesting',
    repositories: bucket.repositories,
    ranked: bucket.ranked.slice(0, limit),
    summary: bucket.summary
  };
}
