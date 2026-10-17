# Repo Digest

A small static blog that reads GitHub and writes up the projects worth your attention. No
framework, no build step for the output, no tracking, no API key required.

```
blog/src/github.mjs   discovery (search), article material (README + file list), ranking
blog/src/build.mjs    renders index.html and one page per post into blog/public/
blog/measure/         the BCE vs Headroom measurement (see MEASUREMENTS.md)
```

## Build

```powershell
node blog/src/build.mjs 4        # 4 repositories per post
```

Output lands in `blog/public/`:

```
index.html
agent-frameworks.html
developer-tooling.html
typescript-ecosystem.html
```

Open `blog/public/index.html` directly, or serve the folder with any static server.

`perPost` (the number argument) controls how many repositories each post covers. The build
reads live GitHub data: search results, README text and a top-level file listing per
repository. Set `GITHUB_TOKEN` to lift the unauthenticated limit from 60 to 5,000
requests/hour.

## How posts are chosen

Star count alone surfaces only giants. `rankRepositories` scores each result on:

| signal | why |
| --- | --- |
| freshness | a push within the last months beats a famous repo nobody maintains |
| stars per day since creation | momentum, not accumulated fame |
| forks | real adoption, which a star-only ranking hides |
| suspicious growth | more than 300 stars/day is penalised: that pattern is usually gamed |

The build ranks **before** reading READMEs, so only the projects that made the cut cost
bytes.

## What a post contains

For each repository: a lede and body taken from its own README (HTML, badges, alert markers
and code fences stripped), why it is worth a look (stars, forks, last push, licence),
language/topic tags, and its top-level files. The project keeps all rights to its README
text; the blog only quotes it.

## Files kept out of git

`blog/public/` is generated output and `blog/measure/.work/` is scratch space. Both are
listed in `.gitignore`.
