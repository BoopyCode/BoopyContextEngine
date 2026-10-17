/**
 * GitHub repo scanner: finds "interesting" repositories via the public search API and
 * scores them, so the A/B test has realistic, bulky tool output to work with.
 *
 * Zero dependencies, no token required (60 requests/hour unauthenticated). Set GITHUB_TOKEN
 * to use a higher limit; the token is read from the environment only, never logged.
 */

const API = 'https://api.github.com';
const USER_AGENT = 'bce-ab-test';

const STOPWORDS = new Set(('the a an and or of for with without to in on at by from is are be this that it its into your you our their as if then than '
  + 'build built create creates created make makes made use uses used using simple small tiny fast lightweight modern minimal minimalistic complete '
  + 'library libraries tool tools framework frameworks project projects app apps application applications code source open free').split(/\s+/));

/** Query presets: what "interesting" means for each run. */
export const QUERIES = {
  ts: 'language:typescript stars:>500 pushed:>2026-07-01',
  rust: 'language:rust stars:>500 pushed:>2026-07-01',
  agents: 'topic:ai-agents stars:>200 pushed:>2026-06-01',
  tooling: 'topic:developer-tools stars:>300 pushed:>2026-06-01',
  vue: 'language:vue stars:>300 pushed:>2026-06-01',
  interesting: 'stars:>1000 pushed:>2026-09-01'
};

function headers() {
  const base = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = process.env.GITHUB_TOKEN;
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

async function api(path, attempt = 0) {
  try {
    const response = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${path} -> HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
  } catch (error) {
    // A dropped socket is common for the free endpoint; retry once with a small backoff.
    // HTTP errors are real answers and must not be retried.
    const transient = !/HTTP \d+/.test(String(error?.message));
    if (transient && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return api(path, attempt + 1);
    }
    throw error;
  }
}

/**
 * Estimates how much an agent would have to read to judge a repository:
 * README (truncated like the Contents API does), languages, topics, recent tags
 * and commit activity. These are exactly the payload shapes a coding agent pulls
 * with tool calls, so this is realistic traffic, not synthetic padding.
 */
async function enrich(repo) {
  const detail = { languages: {}, readme: null, readmeBytes: 0, tags: [], commits: [] };
  await Promise.all([
    api(`/repos/${repo.full_name}/languages`).then((languages) => {
      detail.languages = languages;
    }).catch(() => undefined),
    api(`/repos/${repo.full_name}/readme`).then((readme) => {
      // The Contents API hands back base64; decode the first slice like an agent would.
      const raw = Buffer.from(readme.content ?? '', 'base64').toString('utf8');
      detail.readme = raw.slice(0, 6000);
      detail.readmeBytes = raw.length;
    }).catch(() => undefined),
    api(`/repos/${repo.full_name}/tags?per_page=10`).then((tags) => {
      detail.tags = tags.map((tag) => tag.name);
    }).catch(() => undefined),
    api(`/repos/${repo.full_name}/commits?per_page=5`).then((commits) => {
      detail.commits = commits.map((commit) => ({
        sha: commit.sha?.slice(0, 8),
        date: commit.commit?.author?.date,
        message: (commit.commit?.message ?? '').split('\n')[0]
      }));
    }).catch(() => undefined)
  ]);
  return detail;
}

function keywords(text) {
  const words = (text ?? '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const counts = new Map();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * "Interesting" = maintained, popular, documented, focused.
 * Every component is 0..1 so the weights below stay readable.
 */
export function scoreRepository(repo, detail = { languages: {}, readme: null, tags: [], commits: [] }) {
  const recencyDays = repo.pushed_at ? (Date.now() - Date.parse(repo.pushed_at)) / 86400000 : 365;
  const freshness = Math.max(0, 1 - recencyDays / 120);
  const popularity = Math.min(1, Math.log10(1 + (repo.stargazers_count ?? 0)) / 5);
  const momentum = Math.min(1, (repo.stargazers_count ?? 0) / Math.max(1, (repo.forks_count ?? 1)) / 10);
  const documentation = Math.min(1, (detail.readme?.length ?? 0) / 4000);
  const focus = repo.topics?.length ? Math.min(1, repo.topics.length / 6) : 0;
  const maintenance = detail.commits.length >= 3 ? 1 : detail.commits.length / 3;
  const issueHealth = repo.open_issues_count != null && repo.stargazers_count
    ? Math.min(1, repo.stargazers_count / Math.max(1, repo.open_issues_count) / 20)
    : 0;
  const score =
    0.3 * freshness +
    0.25 * popularity +
    0.1 * momentum +
    0.15 * documentation +
    0.1 * focus +
    0.05 * maintenance +
    0.05 * issueHealth;
  return {
    score: Math.round(score * 1000) / 1000,
    parts: { freshness: round(freshness), popularity: round(popularity), momentum: round(momentum), documentation: round(documentation), focus: round(focus), maintenance: round(maintenance), issueHealth: round(issueHealth) }
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Runs one scan. Returns the ranked result plus per-request diagnostics so the A/B
 * harness can attribute every byte the agent read.
 */
export async function scan({ queries = ['ts', 'rust', 'agents'], perQuery = 6, enrichTop = 4 } = {}) {
  const started = Date.now();
  const repositories = [];
  const requests = [];

  for (const key of queries) {
    const query = QUERIES[key] ?? key;
    const t0 = Date.now();
    const result = await api(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perQuery}`);
    requests.push({ label: `search:${key}`, bytes: JSON.stringify(result).length, ms: Date.now() - t0 });
    for (const repo of result.items ?? []) {
      repositories.push({
        full_name: repo.full_name,
        description: repo.description,
        language: repo.language,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        open_issues: repo.open_issues_count,
        topics: repo.topics ?? [],
        pushed_at: repo.pushed_at,
        created_at: repo.created_at,
        license: repo.license?.spdx_id ?? null,
        archived: repo.archived,
        homepage: repo.homepage,
        default_branch: repo.default_branch
      });
    }
  }

  const unique = new Map(repositories.map((repo) => [repo.full_name, repo]));
  const candidates = [...unique.values()]
    .filter((repo) => !repo.archived)
    .sort((a, b) => b.stars - a.stars);

  const enriched = new Map();
  for (const repo of candidates.slice(0, enrichTop)) {
    const t0 = Date.now();
    const detail = await enrich(repo);
    enriched.set(repo.full_name, detail);
    requests.push({
      label: `enrich:${repo.full_name}`,
      bytes: JSON.stringify(detail).length,
      ms: Date.now() - t0
    });
  }

  const ranked = candidates
    .map((repo) => {
      const detail = enriched.get(repo.full_name);
      const { score, parts } = scoreRepository(repo, detail);
      const text = `${repo.description ?? ''} ${(repo.topics ?? []).join(' ')} ${detail?.readme ?? ''}`;
      const counts = [...keywords(text).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      return {
        full_name: repo.full_name,
        language: repo.language,
        stars: repo.stars,
        score,
        parts,
        topKeywords: counts.map(([word, count]) => `${word}:${count}`),
        readmeBytes: detail?.readmeBytes ?? 0,
        tags: detail?.tags ?? [],
        lastCommit: detail?.commits?.[0]?.message ?? null
      };
    })
    .sort((a, b) => b.score - a.score);

  const totalBytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  return {
    durationMs: Date.now() - started,
    queries,
    repositories: ranked.length,
    enriched: enriched.size,
    requests,
    totalToolOutputBytes: totalBytes,
    ranked: ranked.slice(0, 12),
    summary: summarize(ranked)
  };
}

/** Cheap aggregate the harness prints, so the agent does not need the raw list. */
export function summarize(ranked) {  const byLanguage = {};
  const byTopKeyword = {};
  let stars = 0;
  for (const repo of ranked) {
    byLanguage[repo.language ?? 'unknown'] = (byLanguage[repo.language ?? 'unknown'] ?? 0) + 1;
    stars += repo.stars;
    for (const keyword of repo.topKeywords.slice(0, 2)) {
      const word = keyword.split(':')[0];
      byTopKeyword[word] = (byTopKeyword[word] ?? 0) + 1;
    }
  }
  return {
    repos: ranked.length,
    totalStars: stars,
    byLanguage: Object.fromEntries(Object.entries(byLanguage).sort((a, b) => b[1] - a[1]).slice(0, 6)),
    trendingKeywords: Object.entries(byTopKeyword).sort((a, b) => b[1] - a[1]).slice(0, 8)
  };
}
