# Architecture

## 1. Layers

```text
src/host                      VS Code integration (the only place that imports `vscode`)
  extension.ts                activate/deactivate, wiring, config + folder + trust events
  session.ts                  WorkspaceSession (one per workspace folder) + SessionManager
  ui.ts                       settings reader, output channel logger, status bar
  tools.ts                    six thin LanguageModelTool adapters
  commands.ts                 commands, project map viewer, search quick pick, diagnostics webview
  gitignore.ts                managed `.gitignore` block (idempotent)
  gitRunner.ts                child_process wrapper for git

src/core                      analysis pipeline (no `vscode` import, fully unit tested)
  io/                         FileSystemLike + Node adapter, StoreFs + Node adapter
  ignore/                     built-in exclusions, secret/binary blocks, .gitignore/.bceignore engine
  scan/                       workspace walker (inventory, ignore decisions, symlink guard)
  parse/                      language detection, parser registry, heuristic parsers, import resolver
  index/                      in-memory index, atomic store, incremental indexer
  map/                        project map builder (frameworks, entry points, schema, routes, modules)
  retrieve/                   ranking, snippet extraction
  cache/                      layer 2 context cache (dependency keyed)
  diagnostics/                metrics counters
  vcs/                        optional git signals
  tools/                      input validation + tool handlers (pure functions)
  benchmark/                  reproducible local benchmark
```

`src/core` never imports `vscode`. Everything environment specific is injected:

| Interface | Production implementation | Test implementation |
| --- | --- | --- |
| `FileSystemLike` | `io/nodeFs.ts` | `test/support/memoryFs.ts` (incl. escaping symlinks) |
| `StoreFs` | `io/storeFs.ts` | `test/support/memoryFs.ts` (`MemoryStoreFs`) |
| `CommandRunner` (git) | `host/gitRunner.ts` | inline fake runners |
| `Clock` / `Scheduler` | `util/async.ts` system defaults | deterministic fakes |
| `CancellationLike` | `vscode.CancellationToken` shape | `CancellationTokenSource` |

That is what allows 137 tests to run without a VS Code instance and without a model API.

## 2. Data model

```text
FileRecord     path, hash(sha1), size, mtimeMs, language, kind, symbols[], imports[],
               references[], dependencies[], tests[]/testedPath, confidence, indexedAt, facts
SymbolRecord   name, kind, line, endLine, container, signature, doc, confidence, detail
ProjectIndex   files (Map), ignored[], errors[], stats, indexVersion, parserVersion, rootKey,
               configSignature, complete/partial + L1 parse cache
ProjectMap     overview + modules + dependencies + databaseSchema + entryPoints
```

`confidence` is either `exact` (markdown headings, imports from string literals) or
`heuristic` (everything a regex/brace scanner produced). Tools and the map surface it.

## 3. Indexing flow

```text
initialize()
  store.load():   missing | incompatible (schema/root/parsers) | corrupt (quarantined) | loaded
     loaded  -> reuse, then refresh paths that may have changed since the last session
     else    -> fullIndex()
fullIndex()
  scanner.scan()  -> inventory + ignore decisions
  mapWithConcurrency(parse+hash, limit 4)
      fast path: same size+mtime -> reuse record without reading the file
      hash equal            -> reuse record
      else                  -> L1 parse cache (parserVersion + language + hash) or parser
      every 16 files        -> yield to the event loop (index.yields) so the UI never stalls
  resolve imports -> dependencies, tests -> testedPath/tests[], ignore/error lists
  bumpVersion(); store.save(index) + store.saveMap(map)   (atomic temp+rename, lock guarded)
file events (watcher, debounced 400 ms, max 3 s, coalesced per path)
  handleFileEvent() -> refreshPaths() forces a re-read and re-hash, invalidates affected L2 entries
errors -> the previous record is kept, `partial` is set, a warning goes to the status bar
```

Cancellation uses cancellation tokens end to end (`BCE: Cancel Indexing`), and an in-flight
scan keeps the previously loaded index usable.

## 3b. Editor state versus disk state

The persisted index always describes the **working tree**: hashes must stay comparable with files
on disk, so an unsaved buffer is never written into it. Reads that feed tool output take a
different route:

```text
bce_get_file_context / search snippets
     |
     v
WorkspaceIntelligence.readTextForContext(relPath)
     |- open dirty buffer?  -> use document.getText(), mark the result "UNSAVED editor buffer",
     |                         and re-parse it so symbol lookups match the buffer
     |- otherwise           -> read from disk (size limit + symlink + ignore checks as usual)
```

Consequences that are enforced in code and covered by `test/editorState.test.ts`:

* `bce_get_file_context` never returns code that is behind your editor; a symbol that only exists
  in the unsaved buffer resolves, and a symbol that was renamed away in the buffer is reported as
  `not found` instead of being served from the stale index.
* Search snippets from dirty files are marked and the bundle warns that line numbers refer to the
  buffer, not to disk.
* The layer 2 context cache key includes a fingerprint of `path:version` for every dirty document,
  so an unsaved edit cannot be answered from a cached bundle.
* `bce_get_status` reports how many files have unsaved changes, and explains that they are outside
  the index on purpose.

## 3c. Staying responsive (why the indexer cannot freeze the window)

Parsing is CPU bound and synchronous, so the indexer is cooperative by design:

| Mechanism | Effect |
| --- | --- |
| `yieldToEventLoop()` every 16 parsed files | pending UI events, watchers and language features get the thread back; measured as `index.yields` |
| Bounded concurrency (4 by default) | at most a few files are in flight; no unbounded task fan-out |
| `Debouncer` (400 ms, max 3 s) over a `Set` of paths | a burst of saves collapses into one pass; a repeated event for a path already queued replaces it |
| Re-queue while a pass is running | `flushPending()` defers and retries while `running`/`inFlight > 0`, so an edit made *during* indexing is applied afterwards with the newest content |
| Atomic writes + lock | persistence never blocks or corrupts the index; `store.save` is not in the tool call path |
| Cancellation tokens | a long scan can be aborted at any await point; the last valid index stays usable |

Not implemented (and stated as such in the README): moving parsers into `worker_threads`/Web Workers.
The yield-based approach was chosen because the pipeline spends most of its time in `await`ed file
I/O, the work per file is small, and worker based parsers would need their own module loading and
serialization layer. The interface (`FileParser`, `FileSystemLike`) is worker friendly, so this
remains a possible next step for very large monorepos.

## 4. Key decisions

**JSON + in-memory index instead of SQLite.** The specification allows SQLite "if a relational
database is needed". BCE's working set is a map of ~10^4 small records, queried by key or with
linear scans; a file per concern (`index.json`, `context-cache.json`, `map/*.json`) written
atomically is simpler to inspect, debug, delete and test, and adds no native dependency.
Everything is written through `StoreFs`, so a future SQLite adapter would not change the core.

**Heuristic parsers instead of a full AST/tree-sitter.** There is no single language in scope
(PHP, TS/JS, Python, SQL, JSON, Markdown, YAML, Dockerfile) and shipping parsers for all of them
would dominate the bundle. Instead BCE masks strings/comments, tracks brace depth for containers
and extracts declarations with anchored patterns, marking all of it `heuristic`. The alternative
(claiming semantic completeness) is explicitly forbidden by the spec, so the confidence field is
part of the data model and appears in tool output.

**Index outside the project by default.** Keeps repositories clean and lets two windows of the
same project share the index without touching the working tree. The only file BCE may touch in a
project is the managed block in `.gitignore`.

**Import resolution is declared, not guessed.** An internal import is linked through the mechanism
the ecosystem actually declares: relative specifiers for TS/JS, and `autoload.psr-4` from every
`composer.json` for PHP, longest prefix first. Guessing (`App\` -> `App/`) only works in a flat
layout and fails silently everywhere else, which is worse than failing loudly. Whatever is still
unresolved is counted and printed as `coverage:` on every impact report, so "no dependents" can be
told apart from "the imports could not be linked" - an empty list that reads like a finding is the
one failure mode an impact tool cannot afford.

**Local caching is not a token guarantee.** A cache hit avoids re-doing *local* work. If the same
context is sent to the model again, it can still be billed - the README, the diagnostics view and
the tool output all say so.

**Tools are additive, never mandatory.** BCE registers tools; it cannot and does not intercept
prompts. Prompts still flow through Copilot's own loop. Because models often guess instead of
calling a tool, every `modelDescription` is written as a directive ("CRITICAL - CALL THIS TOOL
FIRST", "ALWAYS use this", "do not guess") that also states when the tool must *not* be used and
that Copilot's own implicit file attachment is redundant once the tool is called.

## 5. Multi-workspace and multi-window behaviour

* One `WorkspaceSession` per workspace folder: separate index, cache, metrics and status.
  Conversation history and in-progress tasks are never shared - BCE has no such state at all.
* The same project opened in two VS Code windows shares the storage directory. Writes are atomic
  (temp file + rename) and guarded by `index.lock` (pid + timestamp, 15 s stale takeover); the
  window that cannot take the lock keeps working in memory and logs a warning.
* Closing a window cannot corrupt the index: writes are atomic and a damaged file is moved aside
  (`index.corrupt-<timestamp>.json` plus a `.reason.txt`) and rebuilt.
* Remote (SSH/WSL/dev container): the extension prefers the workspace extension host
  (`extensionKind: ["workspace"]`), so it sees real files with `node:fs`. Virtual file systems are
  not supported and that is declared in the manifest (`virtualWorkspaces: false`).
* Untrusted workspaces: BCE reads and indexes, but never writes (no `.gitignore` update) and the
  storage location must stay outside the project (`untrustedWorkspaces: limited`).

## 6. Extension points for the next stages

* Parser coverage: add a `FileParser` to `src/core/parse/parsers/` and register it in
  `registry.ts`; bumping its `version` invalidates the affected L1 cache entries automatically.
* Deeper language support: replace a parser with a tree-sitter based implementation behind the
  same interface, keeping `confidence: 'exact'` where it applies.
* New tools: add the entry to `contributes.languageModelTools`, a validator in
  `core/tools/validation.ts`, a handler in `core/tools/handlers.ts`, and one line in
  `host/tools.ts`.

---

Boopy Context Engine is part of the Boopy developer tooling - [boopycode.com](https://boopycode.com).
