# Index storage

## 1. Default location

```text
<VS Code user data>/User/workspaceStorage/<workspace-hash>/boopycode.boopy-context-engine/bce-index/
    index.json                 the index: files, symbols, imports, references, ignore list, errors,
                               stats, layer 1 parse cache
    context-cache.json         layer 2 cache: ranked search results + the content hashes they depend on
    map/
        project-overview.json  languages, frameworks, entry points, modules, routes, DB objects, tests
        modules.json           per-module file counts, languages, top symbols, dependents
        dependencies.json      internal edges, external packages, unresolved specifiers
        database-schema.json   tables/views with columns, foreign keys, migration files
        entry-points.json      detected entry points with their source
    index.lock                 present only while a window writes (pid + timestamp, stale after 15 s)
    index.corrupt-*.json       quarantined damaged index (+ .reason.txt)
    usage.jsonl                append only log of bce_* calls: what was asked, estimated tokens
                               returned, estimated tokens the naive alternative would have cost
```

The project directory is **not** used by default; the only thing BCE may write there is the
managed `.gitignore` block.

Set `bce.storage.location` to `workspace` to move the same content into `<project>/.bce/`
(automatically covered by the managed `.gitignore` block).

## 2. Format

Plain JSON, written atomically (temp file + rename), so a crash or a killed window can never
leave a half written file. The index is also kept fully in memory while a window is open, so
file system writes never sit in the critical path of a tool call.

`index.json` records the compatibility keys: `schemaVersion`, `parserVersion`, `rootKey`
(sha1 of the normalized workspace path), `configSignature` (include/ignore/size settings).
A mismatch means "do not reuse" and triggers a rebuild; a JSON parse failure quarantines the
file instead of deleting it.

## 3. Sharing between windows

Two VS Code windows with the same project folder share the same storage directory:

* writes are atomic, so a reader never observes a partial file;
* `index.lock` (pid + timestamp, taken over after 15 s) prevents interleaved writes; the window
  that cannot take the lock keeps working from memory and logs
  `Index could not be persisted: another VS Code window holds the BCE index lock for this workspace`;
* conversation history, pending tasks and metrics are never shared - they are per window and
  per session. Sharing an index is safe precisely because it contains no task state.

Different workspace folders always get different storage directories (`rootKey`), so indexes
cannot be mixed up.

## 4. Size expectations

The index stores metadata, not source code: roughly a few hundred bytes to a few kilobytes per
file depending on symbol count. The fixture project (27 files) produces ~120 KB; a 20 000 file
monorepo typically lands in the low tens of megabytes. `bce.maxFiles` caps the walk, and the
layer 1 parse cache is capped at 4000 entries internally.

## 5. Inspecting and deleting

* `BCE: Show Project Map` renders the map; the JSON files themselves are listed at the bottom of
  that view and can be opened in the editor.
* `BCE: Show Diagnostics` shows counters, errors and which source ignored which file.
* `BCE: Clear Cache` deletes `context-cache.json` and the in-memory parse cache (the index stays).
* `BCE: Show Usage Report` renders `usage.jsonl`; `BCE: Reset Usage Log` deletes it (the log is
  rotated automatically once it passes 512 KB, keeping the newest 1000 entries).
* `BCE: Rebuild Index` deletes both cache layers and re-parses everything.
* Full removal: close all VS Code windows for the project and delete the `bce-index` directory
  (or `<project>/.bce` when using the workspace location). BCE recreates it on the next start.

Nothing in the index is required to keep working - deleting it only costs one re-index.

## 6. Privacy note

The index contains file paths, symbol names and short code fragments from files that passed the
safety blocks, so treat it with the same care as the source tree itself. It is not encrypted.
The usage log additionally contains the queries and file paths you asked the `bce_*` tools about,
because that is what makes the saved-token estimate possible. It stays on this machine, is never
uploaded, and `BCE: Reset Usage Log` (or `bce.usageLog.enabled: false`) removes or disables it.
See [SECURITY-AND-PRIVACY.md](SECURITY-AND-PRIVACY.md).

---

Boopy Context Engine is part of the Boopy developer tooling - [boopycode.com](https://boopycode.com).
