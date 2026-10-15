# Boopy Context Engine (BCE)

Local project intelligence for **GitHub Copilot Agent mode** in VS Code.

BCE indexes your project in the background, keeps a compact project map, and exposes six
local tools that Copilot can call when it needs context. The goal is simple: fewer tokens
spent on "let me read the whole repository", more tokens spent on the actual task.

* Runs **fully locally** - no paid AI API, no telemetry, no source code upload.
* Never replaces Copilot, its chat UI or its agent loop; BCE is an additional tool provider.
* Honest about limits: parser results are labelled `exact` or `heuristic`, and every token
  number is marked as an *estimate*.

Project home: **[boopycode.com](https://boopycode.com)** — questions, bugs and feature requests belong there.

---

## 1. Install

**A. Ready made build (no toolchain needed)**

Download `bce-0.1.3.vsix` from the [latest release](https://github.com/BoopyCode/BoopyContextEngine/releases/latest)
and install it:

```powershell
code --install-extension bce-0.1.3.vsix
```

Or in VS Code: Extensions view -> `...` -> **Install from VSIX...**

**B. Development host (fastest for working on BCE itself)**

```powershell
npm install
npm run check        # typecheck + tests + bundle
```

Open this folder in VS Code and press `F5` ("Run BCE Extension"). A second VS Code window
opens with BCE loaded - open any project there.

**C. Local VSIX from source**

```powershell
npm run vscode:prepublish
npx @vscode/vsce package
code --install-extension boopy-context-engine-0.1.3.vsix --force
```

Restart VS Code, open a project, and check the status bar for `bce: Indexing` followed by
`bce: Ready (n files)`.

**Requirements:** VS Code 1.99 or newer (Language Model Tool API) and Node 18+. The bundled
extension has a single runtime dependency (`ignore`, bundled by esbuild).

---

## 2. Quick start with Copilot

1. Open a project. BCE indexes it in the background - your editing is never blocked.
2. In Copilot Chat (Agent mode) ask something that spans the codebase, e.g.
   *"add a refund endpoint that reuses the existing order refund logic"*.
3. Copilot can now call BCE tools. You can also reference them explicitly with `#`:
   `#bceFindContext` or `/` slash prompt `bce-context` (see [docs/WORKFLOWS.md](docs/WORKFLOWS.md)).

### Getting the token savings in practice

BCE's tool descriptions are written as directives ("ALWAYS use this before…", "do not guess"),
because models tend to guess instead of calling a tool. Two habits make the difference:

* **Name the tools in the prompt when it matters**: *"fix this bug, use the BCE tools for impact
  analysis"* makes the agent retrieve context once, deliberately, instead of attaching files
  "just in case".
* **Ask for ranges, not files**: every `bce_find_context` result already contains the exact
  `path:line` hits. Opening only those ranges keeps you from paying twice for the same code -
  once through Copilot's own context assembly and once through your file attachments.

Details and prompt templates: [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

---

## 3. The six tools (and when Copilot should use them)

| Tool | Purpose | Use it when | Do not use it when |
| --- | --- | --- | --- |
| `bce_get_project_overview` | Compact map: languages, frameworks, entry points, modules, DB objects, routes, tests, instruction files | You are new to the project or the task spans several modules | You only touch a file you already have open |
| `bce_find_context` | Ranked, de-duplicated hits with reasons, `path:line`, small snippets and a token count | You need to locate responsible code, a table, an endpoint or a symbol | You already know the exact path (use `bce_get_file_context`) |
| `bce_get_file_context` | One symbol or one line range plus imports/dependents/tests | You know the file and need one symbol body | You are exploring unknown code |
| `bce_explain_impact` | Dependents of a symbol/file, split into **verified** references and **heuristic** guesses | Before refactoring, renaming or deleting | For brand new code that is not indexed yet |
| `bce_get_related_tests` | Tests bound by convention/import/usage + runner configuration | Before writing tests, after changing behavior | As proof of coverage |
| `bce_get_status` | Index freshness, counts, cache counters, errors | Results look stale or incomplete | - |

Every tool response ends with provenance: index version, whether the result came from the
local cache, and which signals were used.

### Unsaved editor content

`bce_get_file_context` and the snippets inside `bce_find_context` read the **open editor buffer**
when a file has unsaved changes, so you never get code that is 50 edits behind your screen. Such
results are marked `UNSAVED editor buffer` / `UNSAVED editor content`, their line numbers refer to
the buffer, and `bce_get_status` lists how many dirty files exist. Unsaved text is never written
into the persisted index (hashes must stay comparable with the working tree) and it invalidates the
context cache entry for that query automatically.

### Copilot's own retrieval

Copilot Agent assembles context on its own. When BCE is available, that implicit retrieval becomes
redundant work: the agent may attach files *and* call BCE for the same question. The tool
descriptions therefore instruct the model to treat BCE as the primary context source, and the
recommended prompt pattern is to ask for the tool explicitly on non-trivial tasks - see
[docs/WORKFLOWS.md](docs/WORKFLOWS.md).

---

## 4. Commands

| Command | What it does |
| --- | --- |
| `BCE: Analyze Project` | Runs a full scan/refresh with progress and cancellation |
| `BCE: Rebuild Index` | Drops **both** cache layers and re-parses everything (asks first) |
| `BCE: Show Project Map` | Opens a readable, read-only rendering of the project map |
| `BCE: Search Context` | Quick pick over ranked hits; opens the chosen file at the best line |
| `BCE: Show Diagnostics` | Webview with counters, timings, per-tool usage, recent events |
| `BCE: Clear Cache` | Clears the parse cache and the context cache (index stays) |
| `BCE: Pause Background Indexing` / `Resume` | Queues file events instead of processing them |
| `BCE: Cancel Indexing` | Cancels the running pass; the last valid index is kept |
| `BCE: Ensure BCE Output Is Git-Ignored` | Re-applies the managed `.gitignore` block |
| `BCE: Run Local Benchmark` | Measures ranking quality and context size against a naive baseline |
| `BCE: Show Usage Report` | Renders the local usage log: calls, tokens returned, estimated tokens avoided |
| `BCE: Reset Usage Log` | Deletes the usage log after a confirmation |

---

## 5. Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `bce.enabled` | `true` | Master switch |
| `bce.autoIndex` | `true` | Background indexing + file watching |
| `bce.tokenBudget` | `4000` | Default estimated token budget **per tool response** (not per chat) |
| `bce.maxFileSizeKb` | `512` | Larger files are never indexed or returned |
| `bce.maxFiles` | `20000` | Safety cap on indexed files |
| `bce.respectGitignore` | `true` | Honor `.gitignore` (root and nested) |
| `bce.includePaths` | `[]` | Globs that re-include soft-excluded paths (`generated/**`, `dist/**`) |
| `bce.ignorePaths` | `[]` | Extra exclusions |
| `bce.followSymlinks` | `false` | Follow symlinks (links escaping the workspace are always refused) |
| `bce.autoGitIgnore` | `true` | Keep BCE output out of version control (requires a trusted workspace) |
| `bce.storage.location` | `extensionStorage` | Or `workspace` to write `<project>/.bce` (auto git-ignored) |
| `bce.diagnostics.level` | `normal` | `off`, `normal` or `verbose` output channel logging |
| `bce.search.maxResults` | `12` | Max ranked hits per search |
| `bce.search.snippetLines` | `12` | Max source lines per hit |
| `bce.git.recencyDays` | `14` | Window for the "recently changed" boost |
| `bce.usageLog.enabled` | `true` | Append only log of tool calls and estimated naive baseline |
| `bce.tools.*.enabled` | `true` | Enable/disable each of the six tools individually |

Project level defaults can also live in `.bceignore` (same syntax as `.gitignore`) and in
a committed `.vscode/settings.json`.

---

## 6. What gets indexed (and what never does)

Indexed: sources, tests, migrations/schemas, configuration, documentation, CI workflows,
project instruction files - everything inside the workspace that is not excluded.

**Never indexed, not even with `bce.includePaths`** (safety blocks):

* `.env`, `.env.*` (`.env.example`, `.env.sample`, `.env.template` are allowed as documentation),
* private keys and certificates (`*.key`, `*.pem`, `*.pfx`, `*.p12`, `id_rsa*`, `*.ppk`, ...),
* credential stores (`credentials*.json`, `secrets.json`, `.npmrc`, `.netrc`, `.pgpass`,
  `.aws/credentials`, `kubeconfig`, `terraform.tfstate`, ...),
* binary payloads, files above `bce.maxFileSizeKb`, anything outside the workspace root.

Excluded by default but **overridable** through `bce.includePaths`: `node_modules`, `vendor`,
`dist`, `build`, `out`, `coverage`, caches, lock files, minified bundles, images, fonts.
See [docs/SECURITY-AND-PRIVACY.md](docs/SECURITY-AND-PRIVACY.md) for the full precedence
table, and `test/ignore.test.ts` for the executable specification.

---

## 7. Where BCE keeps its data

Default: VS Code extension storage (`.../User/workspaceStorage/<hash>/<publisher>.<name>/bce-index`).
The project directory stays untouched - except for one managed `.gitignore` block, so BCE output
can never be committed:

```gitignore
# >>> Boopy Context Engine (BCE) - managed block, do not edit >>>
.bce/
.bce-cache/
# <<< Boopy Context Engine (BCE) - managed block <<<
```

Switch to `bce.storage.location: "workspace"` if you prefer `<project>/.bce` (same content,
same git-ignoring). Details, deletion instructions and multi-window behaviour:
[docs/INDEX-STORAGE.md](docs/INDEX-STORAGE.md).

---

## 8. Measuring the benefit honestly

BCE can show that it needs **fewer tokens to find the same files**. It cannot show the
provider's invoice, because VS Code extensions have no access to Copilot/DeepSeek accounting.

* `BCE: Show Diagnostics` - local counters: indexed/updated files, cache hits and misses,
  calls per tool, characters and *estimated* tokens returned, search time, bundle size, errors.
* `BCE: Run Local Benchmark` - derives reproducible tasks from your own project (or reads
  `.bce-benchmark.json`), and compares "what BCE returned" with "reading every candidate file".
* **Usage log** - every tool call is appended to `usage.jsonl` in BCE storage with the estimated
  tokens it returned and, where a fair comparison exists, the estimated tokens the naive route
  would have cost. `BCE: Show Usage Report` opens it, `bce_get_status --verbose` summarises it,
  `BCE: Reset Usage Log` deletes it, and `bce.usageLog.enabled` turns it off.

A run on the repository's own fixture project (`test/fixtures/sample-project`, 27 files, budget
900 estimated tokens per task, snippets disabled - measured, not estimated):

```text
hit rate: 100% , mean rank of first correct hit: 1.4,
estimated context: ~1916 tokens vs ~4792 tokens for the naive baseline (60% smaller)
```

The saving is modest here because the fixture is tiny; on a real repository the baseline grows with
every file whose path or symbols match a query term, while BCE keeps returning a bounded bundle.
Reproduce it with `npm test` (see `test/benchmark.test.ts`) or by running `BCE: Run Local Benchmark`
in your own project.

A second, larger measured run on a generated 618-file project (577 indexed, 12 tasks) is documented
in [docs/BENCHMARK.md](docs/BENCHMARK.md) section 7, together with the before/after-install
comparison:

```text
hit rate: 92% , mean rank of first correct hit: 1.9,
estimated context: ~8634 tokens vs ~171270 tokens for the naive baseline (95% smaller)
```

Reproduce it with `node scripts/generate-project.mjs` and `node scripts/measure.mjs` (dev tooling,
not part of the packaged extension).

### What BCE saved in one real project

The usage log answers this on your own project: it records every tool call, the estimated tokens it
returned, and - where a fair naive alternative exists - what that alternative would have cost. On
this repository (120 files, 663 KB, roughly 170 000 tokens if read whole) the local benchmark reports
6 tasks with a 100 % hit rate, mean rank 2.8, and ~3 902 estimated tokens instead of ~243 211 for
reading every candidate file (98.4 % smaller).

The same log makes the opposite honest case visible: on a small project a 300 token budgeted search
can be *larger* than the handful of files the naive route would have opened, and the report lists
those calls too - that is why the totals show both numbers instead of only the saving.

Treat the baseline as an *estimate of reading work avoided*, and validate the end result with
your own agent session: quality, number of agentic steps and billed usage need a real chat.
See [docs/BENCHMARK.md](docs/BENCHMARK.md).

---

## 9. Architecture in one screen

```text
VS Code Extension Host (src/host)
  activation, status bar, commands, diagnostics webview, file watchers, git, .gitignore
  editor state (unsaved buffers)          <-- dirty documents win over disk content for reads
        |
        v
Core, no `vscode` import, fully unit tested (src/core)
  scanner + ignore engine -> parsers -> incremental index -> project map
  cache (L1 parse / L2 context) -> retriever -> tool handlers
```

Indexing is cooperative: parsing runs in chunks of 16 files with an explicit yield back to the
event loop (`index.yields` in the diagnostics), file events are debounced and coalesced per path,
and a new edit arriving for a file that is currently being indexed is re-queued so the newest
content always wins. That is why a large scan does not freeze the editor.

Everything below `src/host` is testable without an Extension Host: file access, storage, the
clock and the scheduler are injected interfaces (`test/support/memoryFs.ts` provides virtual
implementations, including symlinks that escape the workspace).

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 10. Development

```powershell
npm run typecheck   # tsc --noEmit
npm test            # vitest (147 tests, no model API needed)
npm run compile     # esbuild bundle -> dist/extension.js
npm run check       # all three (ends with the development bundle)
```

Layout: `src/core` (analysis), `src/host` (VS Code integration), `test/` (unit +
integration with a `vscode` mock), `test/fixtures/sample-project` (PHP + TS/JS + SQL + Python
+ README fixture, including files that must never be indexed), `scripts/` (benchmark project
generator and measurement harness, not packaged), `docs/`.

### Packaging and installing locally

```powershell
npm run vscode:prepublish      # minified production bundle, dist/extension.js
npx @vscode/vsce package --out "$env:TEMP\bce.vsix"
code --install-extension "$env:TEMP\bce.vsix" --force
code --uninstall-extension boopycode.boopy-context-engine
```

`npx @vscode/vsce ls` shows what the package contains: `dist/`, `docs/`, `prompts/`, the manifest
and the licence - never `src/`, `test/` or `scripts/`.

Measured behaviour of the development bundle, the production bundle and the installed extension is
compared in [docs/BENCHMARK.md](docs/BENCHMARK.md) section 7.

---

## 11. Status - what works and what does not (v0.1.3)

Implemented and covered by tests:

1. Extension skeleton, activation, status bar, commands, settings, local install path.
2. Scanner with `.gitignore`, `.bceignore`, safe exclusions, secret/binary/size blocks, symlink guard.
3. Incremental index (hash based, debounced, coalesced, cancellable, atomic, lock protected,
   cooperative yielding) + project map.
4. `bce_get_project_overview`, `bce_find_context` (ranking, budget, snippets).
5. `bce_get_file_context` (editor-buffer aware), `bce_get_status`.
6. Cache layers, diagnostics, status bar, benchmark.
7. Impact analysis and related tests, split into verified vs heuristic.
8. Documentation (this file and `docs/`).

Known limitations, stated plainly:

* Parsers are **heuristic**, not full AST parsers: TypeScript/JavaScript brace tracking,
  regex based PHP/Python/SQL/JSON/Markdown/YAML/Dockerfile extraction. Deep generic,
  decorator or macro magic can be missed; such results are marked `heuristic`.
* No deep call-graph or type resolution. `bce_explain_impact` therefore separates verified
  references from text matches instead of pretending to be complete.
* `tsconfig` path aliases and dynamic `require()` are not resolved; unresolved specifiers are
  reported as such in `dependencies.json`.
* A file edited while VS Code is closed is picked up by size/mtime; an edit that preserves both
  size and mtime is only detected through a file event, i.e. while VS Code is open (documented
  trade-off, see `test/indexer.test.ts`).
* Virtual file systems (e.g. `github.dev`) are not supported - BCE needs real files.
* Parsing still happens on the Extension Host thread. It yields every 16 files, so the UI stays
  responsive, but a worker-thread based parser pool would be the next step for very large projects
  (not implemented in 0.1.x).
* Tool invocation depends on the model's decision. Descriptions are written as directives and
  explicit `#`-references always work, but BCE cannot force a call, and Copilot may still assemble
  its own context in parallel - which is why the docs recommend naming the tool in the prompt on
  non-trivial tasks.
* In untrusted workspaces BCE analyzes read-only and skips the `.gitignore` update.
* Queries that name an implementation symbol can push the matching *test* file out of the returned
  window (measured: `Service04_0 test compute`); the top hit still carries a `tests:` pointer and
  `bce_get_related_tests` returns the file directly.
* v0.1.x exposes tools and commands; there is no separate onboarding wizard or marketplace
  publishing pipeline.
* The full benchmark comparison (with and without BCE, including answer quality) still has to be
  run manually in a Copilot session; BCE only automates the local, measurable half.

---

## 12. Documentation

| Document | Content |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, data model, decisions (why JSON instead of SQLite, why heuristic parsers), incremental flow |
| [docs/SECURITY-AND-PRIVACY.md](docs/SECURITY-AND-PRIVACY.md) | Ignore precedence, safety blocks, symlink handling, what is never read, threat notes |
| [docs/INDEX-STORAGE.md](docs/INDEX-STORAGE.md) | Where the index lives, formats, sharing between windows, deletion |
| [docs/BENCHMARK.md](docs/BENCHMARK.md) | How to reproduce the benchmark, what it does and does not prove |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Using BCE to write documentation and to generate tests, preventing duplicate retrieval, with prompts |

MIT licensed. Built by BoopyCode - [boopycode.com](https://boopycode.com).
