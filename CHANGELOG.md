# Changelog
## [0.2.0] - 2026-10-17

**Boopy Context Engine only.** This release contains no third-party compression layer and
makes no network calls. The pipeline is the one BCE always had: index locally, return small
pre-ranked slices, let Copilot spend its tokens on the task.

### What changed

* **Tool dispatch is leaner.** Payload handling was collapsed back to one path
  (_render -> measure -> return_). Every leftover hook, setting and code path from earlier
  experiments is gone; `src/`, `test/` and `package.json` contain no external compression
  dependency or configuration.
* **198 tests, zero network.** The suite still needs no model API and no key.
* **Benchmarked on a real GitHub workload.** See "How much context BCE actually avoids" below.

### How much context BCE actually avoids

Measured with one tokenizer (tiktoken `cl100k_base`) and one price list for every row, on a
real workload: a static-site project of 112 files plus 12 repositories read from the public
GitHub API.

| step | prompt tokens | cost (DeepSeek V4 Flash list) | what an agent had to read |
| --- | ---: | ---: | --- |
| naive: open everything | 1,068,248 | $0.2350 | 112 project files + tree listings + 12 whole repositories |
| with BCE | **8,013** | **$0.001763** | project overview, twelve ranked hits, one exact symbol slice |

**99.2% of the naive context never had to be read.** That is not a compression ratio - it is
1.06M tokens of files that were never opened. The nine BCE calls that replaced them returned
the project map, twelve ranked hits and one function body.

Honest limits: the 12 remote repositories are priced from their GitHub-reported size
(`size x 1024 / 3.6`), which is an estimate and the largest single contributor to the naive
baseline (873,816 of the 1,068,248 tokens). The 112 project files are measured exactly on
disk. Nothing here measures answer quality - a cheaper context that omits the file the agent
needed is not a saving, which is why the tools report hit counts and coverage alongside
their token estimates.

## [0.1.9] - 2026-10-16

Ranking, honest numbers, coverage and a two-phase lookup. Each change comes from a measured
problem in a real session, not from a wish list.

### Added

* **`bce_find_context` gained `symbolsOnly` (two-phase lookup).** It returns a ranked `path:line`
  index with matched symbol names and `why:` reasons but no code bodies, and it ranks several times
  more candidates than snippet mode for the same budget. The habit it enables - list first, read one
  body second - removes the largest remaining waste, paying for nine snippets to use the tenth.
* **The usage report now carries a range and a retrieval quality table.** The saving is printed as
  `~low to ~high` where the high end is labelled **upper bound**, plus lines, truncated calls and a
  follow-up ratio. Token savings are explicitly *not* a quality signal: a query returning nothing
  saves everything.
* **`coverage:` appears in the `bce_find_context` answer and in `bce_get_status`,** not only in an
  impact report. Below 100% linked imports an empty result is a hole in the graph, and the answer
  now says so instead of leaving the agent to interpret silence.

### Fixed

* **Symbol ranking treated `contains` almost as strongly as `equals`.** In the reported case a query
  for one `adminAuth` was buried under 27 routes that merely contained the word *admin*. Matching is
  now weighted: exact name (16) > whole identifier word (13) > qualified word (12) > prefix (7) >
  substring (3) > signature (1.5) > doc (0.5), and a symbol **named after the file it lives in** gets
  a further +5. Query words like `route`, `table` or `component` now *reinforce* a matched symbol's
  declared kind (+3) instead of only adding to the file.
* **A plural in a symbol was invisible to word matching.** `splitIdentifier` keeps the original
  casing and the plural, so `userReports` matched the term "report" only as a weak substring. Word
  comparison now lowercases both sides and ignores a simple trailing plural.
* **The honest-numbers lower bound was computed as the sum of the baselines,** which is just the
  upper bound again. It is now the cheapest matching file repeated for every measured call, so two
  calls with different footprints produce a real spread.

### Tests

* `test/symbolRanking.test.ts` pins the weight ordering, the word-vs-substring gap and the plural
  rule - the exact cases the old scoring got wrong.
* `test/retrievalQuality.test.ts` covers `symbolsOnly` (no code bodies, more candidates, lower
  tokens), the coverage caveat on an empty result, the reported range, the "not a quality signal"
  wording, and the empty/productive call counters.
* 192 tests pass; `npm run typecheck` and `npm run compile` are clean.

## [0.1.8] - 2026-10-16

The contributed instructions now say *when* they apply, not only what they say.

### Fixed

* **`prompts/bce-recommended.instructions.md` gained `applyTo: '**'`.** Without it the file was
  discovered - VS Code does sync it into the customization plugin, as
  `rules/bce-recommended.instructions.md` - but it was only reachable when the model chose to load it
  on demand from its `description`. That is the weakest of the three activation paths, and in practice
  an agent that had not been told about BCE went straight to `grep`: measured over a full day of work
  on a real repository, the extension logged **zero** self-initiated tool calls. `applyTo` makes the
  file attach to every file the agent touches, which is the channel that is documented to work.
* `test/extension.test.ts` now fails when a contributed instructions file has no `applyTo`, so this
  specific regression cannot come back unnoticed.

### Known limitation

* Extension-contributed instructions are the least documented of the three paths (project files under
  `.github/instructions`, `AGENTS.md`, and contributed files). Where the outcome matters, add the same
  guidance to `.github/instructions/` in the project as well - the two are additive and a duplicate is
  cheaper than an agent that never learns the tools exist.


All notable changes to the Boopy Context Engine (BCE) are documented here.

## [0.1.7] - 2026-10-16

Impact analysis stopped claiming that code had no dependents. Both bugs come from a real repository
where `PaymentService::delete()` has five callers and BCE answered *"verified parser references (0) -
these are safe to trust"*.

### Fixed

* **PHP references named after a keyword of another language were dropped while parsing.** The
  reserved word list was shared by every parser and contained `delete`, `get`, `set`, `default`,
  `with`, `of`, `is` and `type`. `delete` is a JavaScript keyword, but an ordinary PHP method name -
  so `$this->payments->delete(...)` was removed before any analysis could see it. Each parser now
  filters with its own list (`PHP_KEYWORDS`, `PYTHON_KEYWORDS`) while real language constructs
  (`array(`, `list(`, `isset(`, `print(`, `declare(`) stay ignored.
* **PHP namespaces were resolved without reading `composer.json`.** `App\Services\PaymentService` was
  guessed as `App/Services/PaymentService.php` or by a case-insensitive suffix match, which fails in
  any layout where the application lives in a subdirectory (`App\` -> `backend/src/`). Every
  `use App\...` import stayed unresolved and the whole backend reported zero dependents.
  `autoload.psr-4` (and `autoload-dev.psr-4`) from every `composer.json` is now read, longest prefix
  first, before falling back to the heuristics.
* **An unresolved namespace was counted as an external package.** The dependency graph classified
  anything not starting with `.` or `@` as external, so a completely unlinked PHP import graph still
  reported a healthy index. A namespace is now internal when its root is a namespace the project
  actually declares; vendor namespaces (`Psr\`, `Slim\`, `Dotenv\`) remain external.

### Added

* **`bce_explain_impact` accepts `Class::method`.** The qualified form missed the symbol table (which
  is keyed by the bare name) and quietly fell back to file level, so the answer described a file
  while the question was about a method.
* **A `coverage:` line on every impact report**, for example
  `coverage: 100% of internal imports linked (0/307 unresolved, 0 file(s) affected)`. On the
  repository above it read `75%` before the resolver fix and `100%` after it, so the number is a real
  signal and not a formality.
* **`NOT ANALYSED` instead of an empty report.** When the requested symbol or class cannot be
  located, the three empty sections are no longer printed: *"verified parser references (0) - these
  are safe to trust"* reads as a finding, and an empty list is far more often a hole in the index
  than an answer. When the graph itself is incomplete, that same section says so instead.
* **Contributed instructions** (`contributes.chatInstructions`). Until now the only thing telling an
  agent that BCE exists was a slash command a human had to invoke, so an agent that had not been told
  about the extension never used it. The contributed file states the order of operations and how to
  read `coverage:` and `NOT ANALYSED` honestly.
* **`test/extension.test.ts` guards the contributed instructions.** A typo in the `path`, a missing
  file or a missing frontmatter field would leave the extension working while the agent never learns
  that BCE exists, so the manifest entry, the file and its `name`/`description` are now asserted. The
  test also rejects snake_case tool ids inside the instructions: a chat prompt only resolves the
  camelCase `toolReferenceName` (`bceImpact`), which is exactly the mistake the older
  `prompts/bce-context.prompt.md` still contains.
* **Section 8 of `docs/BENCHMARK.md`** records the measured before/after on a real PHP repository -
  the two impact bugs, and the fact that the intermediate fix reported `75 %` coverage instead of
  `100 %`, which is what exposed the second cause.

### Changed

* The `bce_explain_impact` and `bce_find_context` descriptions mention `Class::method` and the
  coverage line, because the description is what an agent reads after it has already decided to go
  looking for the tool.

## [0.1.6] - 2026-10-15

The tool descriptions were rewritten. What mattered was not their length but their first words.

### Changed

* **`bce_get_project_overview` no longer opens with "CRITICAL - CALL THIS TOOL FIRST".** An
  instruction that is unconditionally in scope is applied to work it has nothing to do with - in one
  measured session an agent answered "fix the licence file" and "write a changelog entry" by mapping
  a different project than the one it was editing. It now states the trigger ("the task needs the
  shape of the project"), and the counter-case: skip it while already working inside a known file,
  on a trivial edit, or when the call is not about the project being changed.
* **`bce_get_status` is no longer described as the tool to call before relying on anything.** It now
  says what it is for: stale or missing results, "is the index ready", large refactors.
* The remaining four lost the same imperative framing (`PRIMARY CONTEXT SOURCE - ALWAYS use this`,
  `ALWAYS use this instead of reading a whole file`, `MANDATORY before renaming`, `ALWAYS use this
  before writing new tests`). Their triggers and, just as importantly, their "do NOT use it for"
  cases are unchanged - only the always/never framing is gone, so a model weighs the description
  instead of obeying a standing order that is already stale by the time it is read.

## [0.1.5] - 2026-10-15

A bug-fix release for the two things that made BCE look broken without saying why: the diagnostics
panel reloading itself every two seconds, and a failed tool call reporting nothing but "failed".

### Added

* `BCE: Show Usage Report` now says plainly that no `bce_*` tool call has been logged yet instead of
  only printing zeroes, explains that BCE can only measure its own six tools, and prints the absolute
  path of `usage.jsonl` so the raw file can be inspected.
* A failed `bce_*` call now records **why** it failed (`reason` in `usage.jsonl`) and the usage report
  shows it as `FAILED: <reason>` instead of a silent zero, plus a `1 failed` note on the call count.

### Fixed

* **The diagnostics panel no longer replaces its own document every two seconds.** `BCE: Show
  Diagnostics` reassigned `webview.html` on a timer, and every assignment reloads the whole webview
  document (which also reset scroll position and lost the reading position). The document is now
  rendered once and live refreshes are pushed into it with `postMessage`; running the command again
  reveals the already open panel instead of opening a second one. Repeatedly reloading a webview
  document is one of the ways VS Code ends up showing "Error loading webview: Could not register
  service worker" instead of content, so this removes BCE's contribution to that VS Code bug (see
  [microsoft/vscode#247035](https://github.com/microsoft/vscode/issues/247035), whose workaround is
  closing all VS Code windows and deleting the `Service Worker` folder in the user data directory).
* **One tool that VS Code refuses to register no longer disables the other five.** The extension
  reported every tool as registered even when `vscode.lm.registerTool` threw, so a bad contribution
  for a single tool silently removed it from Copilot while the other tools kept working. Registration
  is now guarded per tool, the warning names the tool, and a failure to register no longer prevents
  the remaining tools from being registered.

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
