/**
 * Renders the blog. Plain HTML, no framework, no build step: the output is a folder of
 * static files you can open directly or serve with any static server.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_PLAN, describeRepository, formatStars, rankRepositories, readRepository, searchRepositories } from './github.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1b1b1b; --muted:#6b6b6b; --bg:#fbfbf9; --line:#e4e2dd; --accent:#2f5d8a; }
@media (prefers-color-scheme: dark) { :root { --fg:#e8e6e1; --muted:#9a978f; --bg:#141414; --line:#2b2b2b; --accent:#8ab4dd; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 ui-serif, Georgia, serif; }
header, main, footer { max-width: 46rem; margin: 0 auto; padding: 0 1.25rem; }
header { padding-top: 3.5rem; }
header h1 { font-size: 1.9rem; margin: 0 0 .35rem; letter-spacing: -.02em; }
header p { color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: .9rem; margin: 0 0 2rem; }
nav { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:.6rem 0; margin-bottom:2.5rem; font-family: ui-sans-serif, system-ui, sans-serif; font-size:.85rem; }
nav a { color:var(--muted); text-decoration:none; margin-right:1.1rem; }
nav a:hover { color: var(--accent); }
article { margin-bottom: 3.2rem; }
article h2 { font-size: 1.3rem; margin: 0 0 .2rem; }
article h2 a { color: inherit; text-decoration: none; }
article h2 a:hover { color: var(--accent); }
.meta { font-family: ui-sans-serif, system-ui, sans-serif; font-size:.8rem; color:var(--muted); margin-bottom:.7rem; }
.lede { margin:.4rem 0 .6rem; }
.tags { font-family: ui-sans-serif, system-ui, sans-serif; font-size:.75rem; color: var(--muted); }
.tags span { border:1px solid var(--line); border-radius:999px; padding:.05rem .5rem; margin-right:.3rem; display:inline-block; margin-bottom:.3rem; }
footer { padding-bottom:4rem; margin-top:4rem; border-top:1px solid var(--line); font-family: ui-sans-serif, system-ui, sans-serif; font-size:.8rem; color:var(--muted); }
footer p { margin:.55rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em; }
.pager { font-family: ui-sans-serif, system-ui, sans-serif; font-size:.85rem; margin-top:2rem; }
`;

function layout({ title, description, body, nav = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Repo Digest</h1>
  <p>A small blog that reads GitHub and writes up the projects worth your attention. Static HTML, no tracking.</p>
  ${nav ? `<nav>${nav}</nav>` : ''}
</header>
<main>${body}</main>
<footer>
  <p>Generated from the public GitHub API. Stars and dates are a snapshot, not live numbers.</p>
  <p>Content is derived from each project's own README; the projects keep all rights to it.</p>
</footer>
</body>
</html>
`;
}

function renderPostCard(post, index) {
  return `<article>
  <h2><a href="${post.slug}.html">${escapeHtml(post.title)}</a></h2>
  <div class="meta">${post.entries.length} repositories &middot; ${escapeHtml(post.query)}</div>
  <p class="lede">${escapeHtml(post.intro)}</p>
  <div class="tags">${post.entries
    .slice(0, 3)
    .map((entry) => `<span>${escapeHtml(entry.name)}</span>`)
    .join('')}</div>
</article>`;
}

function renderPost(post, posts) {
  const list = post.entries
    .map(
      (entry) => `<article>
  <h2><a href="${escapeHtml(entry.url)}" rel="noopener">${escapeHtml(entry.name)}</a></h2>
  <div class="meta">${escapeHtml(entry.why)}</div>
  <p class="lede">${escapeHtml(entry.lede)}</p>
  ${entry.body ? `<p>${escapeHtml(entry.body)}</p>` : ''}
  <div class="tags">${entry.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
  ${entry.files.length > 0 ? `<div class="meta" style="margin-top:.6rem">top-level: ${entry.files.map((file) => escapeHtml(file.name)).join(', ')}</div>` : ''}
</article>`
    )
    .join('\n');

  const others = posts.filter((other) => other.slug !== post.slug);
  const nav = others.map((other) => `<a href="${other.slug}.html">${escapeHtml(other.title)}</a>`).join('');
  const body = `<h2 style="font-size:1.5rem;margin-bottom:.3rem">${escapeHtml(post.title)}</h2>
<div class="meta">${post.entries.length} repositories &middot; query <code>${escapeHtml(post.query)}</code></div>
${list}
<div class="pager"><a href="index.html">&larr; All posts</a></div>`;
  return layout({ title: `${post.title} - Repo Digest`, description: post.intro, body, nav });
}

/** Builds the whole blog. Returns the posts plus the bytes GitHub made us read. */
export async function buildBlog({ perPost = 4 } = {}) {
  mkdirSync(out, { recursive: true });
  const posts = [];
  let githubBytes = 0;
  let apiCalls = 0;

  for (const plan of POST_PLAN) {
    const search = await searchRepositories(plan.query, perPost + 4);
    githubBytes += search.bytes;
    apiCalls += 1;

    const entries = [];
    // Rank before reading READMEs: only the best `perPost` projects are worth the bytes.
    for (const repo of rankRepositories(search.repositories).slice(0, perPost)) {
      const detail = await readRepository(repo.name);
      githubBytes += detail.readmeBytes + detail.filesBytes;
      apiCalls += 2;
      const article = describeRepository(repo, detail);
      entries.push({
        name: repo.name,
        url: `https://github.com/${repo.name}`,
        stars: formatStars(repo.stars),
        ...article
      });
    }

    const languages = [...new Set(search.repositories.map((repo) => repo.language).filter(Boolean))];
    posts.push({
      slug: plan.slug,
      title: plan.title,
      query: plan.query,
      intro: `${search.repositories.length} projects from GitHub, ranked by freshness and adoption rather than star count alone. Mostly ${
        languages.slice(0, 3).join(', ') || 'mixed'
      }.`,
      entries
    });
  }

  const nav = posts.map((post) => `<a href="${post.slug}.html">${escapeHtml(post.title)}</a>`).join('');
  writeFileSync(
    join(out, 'index.html'),
    layout({
      title: 'Repo Digest',
      description: 'A small static blog about interesting GitHub repositories.',
      body: posts.map(renderPostCard).join('\n'),
      nav
    })
  );
  for (const post of posts) {
    writeFileSync(join(out, `${post.slug}.html`), renderPost(post, posts));
  }

  return { posts, githubBytes, apiCalls, out };
}

const result = await buildBlog({ perPost: Number(process.argv[2] ?? 4) });
console.log(
  `built ${result.posts.length} posts (${result.posts.reduce((sum, post) => sum + post.entries.length, 0)} repositories) into ${result.out}`
);
console.log(`GitHub made us read ${(result.githubBytes / 1024).toFixed(1)} KB over ${result.apiCalls} API calls`);
