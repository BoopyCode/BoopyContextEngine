# Changelog

All notable changes to the Boopy Context Engine (BCE) are documented here.

## [0.1.4] - 2026-10-15

Answering "how much did BCE actually save?" with data instead of a promise.

### Added

* **Usage log** (`bce.usageLog.enabled`, default on): every `bce_*` call is appended to
  `usage.jsonl` in BCE's storage (next to the index) together with the estimated tokens it returned
  and, where a naive alternative exists, the estimated tokens that alternative would have cost.
  Baselines are deliberately conservative: `bce_find_context` is compared against reading every
  file whose path or symbol names match a query term, `bce_get_file_context` against reading that
  whole file, and the other tools are logged without a baseline instead of inventing one. The log is
  local only, rotated at 512 KB, and never leaves the machine.
* `BCE: Show Usage Report` renders the log (totals, per tool, recent calls, how to read it) and
  `BCE: Reset Usage Log` deletes it after a confirmation.
* `bce_get_status --verbose` now reports `estimated context avoided` and where the log lives.
* `test/usage.test.ts` (10 tests) plus a host level test that a real tool call writes the log, shows
  up in the status output and in the rendered report.

### Fixed

* **The managed `.gitignore` block is CRLF safe.** The block was rewritten with `LF` and the text
  after it was trimmed with an `LF` only pattern, so on a Windows checkout every activation added
  another blank line to `.gitignore`. The writer now uses the file's own line ending; verified on
  this repository (BCE leaves `git status` clean) and pinned by a CRLF regression test.

### Changed

* The naive baseline calculation moved to `core/benchmark/baseline.ts`, shared by the benchmark and
  the live usage log, so both report the same number for the same query.
* `scripts/measure.mjs` measures any project: it runs the benchmark command first and reuses the
  tasks that produced (from `.bce-benchmark.json` or derived from the project map).
* Test harness waits are generous, because the indexer tests failed on a loaded machine.

## [0.1.3] - 2026-10-15

Lifecycle hardening found while chasing leaked temporary directories in the test suite, plus
project links.

### Fixed

* **`WorkspaceSession.updateConfig()` could restart indexing on a closed session.** After a
  workspace folder was closed (or the extension deactivated), a settings change could still reach
  that session and trigger a full index pass against the old storage location. The method now
  returns immediately for disposed sessions, like the rest of the session API.
* **`ProjectIndexer` no longer works or writes after `dispose()`**: `initialize`, `fullIndex`,
  `refreshPaths`, `handleFileEvent` and the pending-path flush all bail out, and a run that was
  cancelled or disposed during indexing no longer persists its results ("the previous index was
  kept"). Previously a starved background pass could write to the index store after the session
  that owned it was gone.
* Test hygiene: `test/extension.test.ts` now disposes `context.subscriptions` in `afterEach` (the
  real deactivation path), which stops configuration-change listeners from earlier tests from
  reaching closed sessions, and waits for the background index to become idle before deleting the
  temporary directories. That removed seven leaked `%TEMP%\bce-ext-storage-*` directories per run
  (`test/support/tempProject.ts` also verifies that a removal actually stuck).

### Documentation

* Project links: `boopycode.com` added to the README header and footer, to every document in
  `docs/`, and as the `homepage` field in `package.json`.

## [0.1.2] - 2026-10-15

Packaging and reproducibility fixes found while measuring the extension.

### Fixed

* `package.json` no longer declares a leftover self-dependency
  (`"boopy-context-engine": "file:"`). It broke `npx @vscode/vsce package`
  (`npm error code ELSPROBLEMS`) and would break publishing.
* `.vscodeignore` excludes `scripts/**` and the measurement result files, so the packaged
  extension only contains runtime files (14 files, 84 KB VSIX instead of 18 files, 94 KB).

### Added

* `scripts/generate-project.mjs`: deterministic synthetic project (30 modules, 618 files including
  `node_modules`, build output and secret files that must never be indexed) plus a
  `.bce-benchmark.json` with 12 tasks and known expected answers.
* `scripts/measure.mjs`: drives the real extension surface (activation, the six `bce_*` tools and the
  local benchmark command) through the test-suite `vscode` stand-in, one process per round, and can
  diff two result files (`--compare`).
* Measured results for the extension before and after installing it into VS Code are summarised in
  `docs/BENCHMARK.md`.

## [0.1.1] - 2026-10-15

Hardening of the "the model should actually use this" and "the editor is the truth" concerns.

### Added

* **Editor state instead of only disk state**: `bce_get_file_context` and search snippets now read
  open editor buffers with unsaved changes (`vscode.workspace.textDocuments`, injected into the core
  through an `OpenDocumentProvider`). Dirty buffers are re-parsed so symbol lookups match the
  buffer, results are labelled `UNSAVED editor buffer` / `UNSAVED editor content`, dirty snippets
  warn about shifted line numbers, and the layer 2 cache key includes a dirty-document fingerprint
  so an unsaved edit can never be answered from a stale cache entry. Unsaved content is deliberately
  never written into the persisted index (hashes must stay comparable with the working tree).
  `bce_get_status` now reports unsaved buffers.
* **Directive tool descriptions**: all six `modelDescription` values were rewritten as directives
  ("CRITICAL - CALL THIS TOOL FIRST", "ALWAYS use this", "do not guess"), including explicit
  guidance that implicit file attachment is redundant once the tool is called, and the find-context
  output now tells the agent to open only the returned ranges instead of attaching whole files.
* **Cooperative indexing**: the indexer yields to the event loop every 16 parsed files (counted as
  `index.yields` in the diagnostics), and an edit that arrives for a file which is currently being
  indexed is queued and applied afterwards, so the newest content always wins.
* Tests: `test/editorState.test.ts` (9 tests) plus a host-level extension test proving the wiring,
  documenting that a dirty buffer wins over disk, is excluded from the index, invalidates the
  context cache, appears in the status output, and that bursts of file events collapse into one
  incremental pass.

### Documentation

* README: "Getting the token savings in practice", the "Unsaved editor content" and "Copilot's own
  retrieval" sections, responsiveness note and updated limitations (worker threads not implemented).
* `docs/ARCHITECTURE.md`: sections 3b (editor state vs disk state) and 3c (staying responsive).
* `docs/SECURITY-AND-PRIVACY.md`: unsaved buffers in the guarantees and in "what leaves the machine".
* `docs/WORKFLOWS.md`: section on preventing duplicate retrieval, honesty about what BCE cannot force.

## [0.1.0] - 2026-10-14

First working version: the full scope of stage 1-8 of the specification.

### Added

* **Extension host**: activation on startup, per-workspace-folder sessions, status bar
  (`Indexing`, `Ready`, `Warning`, `paused`, `off`), output channel, configuration handling,
  workspace folder and workspace trust events.
* **Scanner**: workspace inventory with `.gitignore` (root and nested), `.bceignore` (root and
  nested), user include/ignore patterns, built-in noise exclusions, hard safety blocks for secrets,
  private keys and credential stores, binary detection, file size limits, symlink escape guard and
  file count caps.
* **Parsers** (all labelled with confidence): TypeScript/JavaScript (classes, interfaces, types,
  enums, namespaces, functions, methods, components, imports, references, Express/NestJS/Next
  routes), PHP (namespaces, `use`, classes/traits/interfaces/enums, methods, properties,
  constants, Laravel routes and schema builder statements), Python (classes, methods, functions,
  imports, Flask/FastAPI/Django patterns), SQL (tables, columns, views, indexes, types, foreign
  keys), JSON (`package.json`/`composer.json`/`tsconfig` facts), Markdown (headings, code fences),
  YAML (compose services, workflow jobs/triggers), Dockerfile (stages, ports), plain text
  (`requirements.txt`, INI/TOML sections).
* **Index**: incremental, hash based, mtime/size fast path, debounced file event queue, bounded
  concurrency, cancellation, atomic persistence, lock file for multi-window safety, corrupt index
  quarantine, parser/config/root compatibility checks, error states that keep the last valid record.
* **Project map**: `project-overview.json`, `modules.json`, `dependencies.json`,
  `database-schema.json`, `entry-points.json` with framework detection, entry points, API routes,
  database objects, test bindings and module dependency counts.
* **Retriever**: tokenisation, weighted scoring over paths, symbols, signatures, imports and kind
  hints, import graph proximity, recency and entry point boosts, scope filtering, deduplication,
  token budget with truncation reporting, snippet extraction with line numbers.
* **Language model tools**: `bce_get_project_overview`, `bce_find_context`, `bce_get_file_context`,
  `bce_explain_impact`, `bce_get_related_tests`, `bce_get_status` - each with `modelDescription`,
  JSON input schema, input validation, an invocation message and no-prompt-interception guarantees.
* **Cache**: layer 1 (parsed file data keyed by parser version + language + content hash) and
  layer 2 (context results keyed by tool/index version/settings/query with dependency hashes and
  dependency scoped invalidation and expiry).
* **Diagnostics**: counters (files indexed/updated/removed, ignore reasons, cache hits/misses,
  errors), timings, per-tool call statistics with estimated tokens, recent events, diagnostics
  webview, `bce_get_status` verbose output, and explicit "this is an estimate" disclaimers.
* **Benchmark**: reproducible task derivation from the project (or `.bce-benchmark.json`), hit rate,
  mean rank, BCE vs naive baseline token comparison, and an honest list of what is not measurable.
* **Commands**: Analyze Project, Rebuild Index, Show Project Map, Search Context, Show Diagnostics,
  Clear Cache, Pause/Resume/Cancel Indexing, Ensure BCE Output Is Git-Ignored, Run Local Benchmark.
* **Automatic git ignoring**: a managed, idempotent block in the project `.gitignore` keeps
  `.bce/` and `.bce-cache/` out of version control in every project BCE touches.
* **Tests**: 137 tests covering the scanner and ignore rules, parsers, hash based change detection,
  cache invalidation, ranking, token budget, path escape protection, multi-workspace isolation,
  corrupt/incomplete indexes, indexing error states, tool input validation and tool handlers, the
  git ignore block and a full extension activation against a `vscode` mock, plus a fixture project
  with PHP, TypeScript/JavaScript, SQL, Python and README files.
* **Documentation**: README and `docs/` (architecture, security and privacy, index storage,
  benchmark, documentation and test generation workflows) plus a reusable prompt file.

### Known limitations

* Heuristic parsers rather than full ASTs; deep generics/macros can be missed.
* No type resolution or call graph; impact analysis marks heuristic results as such.
* `tsconfig` path aliases and dynamic requires are not resolved.
* Edits that keep both size and mtime while VS Code is closed are only caught after the file changes
  again.
* Virtual file systems are not supported; untrusted workspaces are read-only.
