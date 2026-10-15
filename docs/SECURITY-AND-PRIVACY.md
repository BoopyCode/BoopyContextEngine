# Security and privacy

BCE is designed so that working with it cannot leak project secrets into a model context, and
cannot be used as a file-exfiltration primitive by the agent.

## 1. Guarantees

* **Local only.** Indexing, parsing, ranking and caching happen inside the extension host. There
  is no network call anywhere in the codebase - not even for framework detection.
* **No telemetry** of any kind, no crash reporting, no usage upload.
* **Read-only analysis.** BCE never executes project code, never runs build/test commands, and
  never edits source files. The only file it may write inside a project is the managed block in
  `.gitignore` (disable with `bce.autoGitIgnore`), and only in a trusted workspace.
* **Editor state is respected, not persisted.** Unsaved editor buffers are used for reads when the
  file is dirty (otherwise the agent would see stale code), but they are never written into the
  persisted index and never parsed into a saved artifact. See
  [ARCHITECTURE.md](ARCHITECTURE.md) section 3b.
* **No prompt interception.** BCE registers language model tools; it cannot modify prompts or the
  Copilot agent loop, and it does not try to.
* **Workspace confinement.** Every path is validated twice: syntactically (no absolute paths
  outside the root, no `..` escapes) and physically (symbolic links are resolved and refused when
  they leave the root).

## 2. What is never indexed or returned

Safety blocks are hard: they apply before any user configuration, so `bce.includePaths` cannot
re-enable them, and a tool call for such a path is refused with an explanation.

| Category | Examples |
| --- | --- |
| Environment secrets | `.env`, `.env.local`, `.env.*` (but `.env.example`, `.env.sample`, `.env.template`, `.env.dist` are allowed as documentation) |
| Private keys / certificates | `*.key`, `*.pem`, `*.pfx`, `*.p12`, `*.jks`, `*.keystore`, `*.ppk`, `*.gpg`, `*.asc`, `id_rsa*`, `id_ed25519*` |
| Credential stores | `credentials*.json`, `secrets.json`, `secrets.yml`, `*service-account*.json`, `.npmrc`, `.yarnrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.my.cnf`, `.htpasswd`, `.aws/credentials`, `.docker/config.json`, `kubeconfig`, `terraform.tfstate` |
| Binary payloads | images, fonts, archives, executables, `*.sqlite`, `*.db`, `*.pdf`, office documents |
| Oversized files | anything above `bce.maxFileSizeKb` (default 512 KB) |
| Outside the workspace | absolute paths outside the root, `..` traversal, escaping symlinks |

Additional noise exclusions (`node_modules`, `vendor`, `dist`, `build`, `coverage`, caches, lock
files, minified bundles, `*.svg`, ...) are *defaults* and can be re-enabled with
`bce.includePaths`. The distinction matters: noise `dist/**` may be indexed if you ask for it,
a `.env` never.

## 3. Ignore precedence (first match wins)

```text
1. safety blocks            never indexable, never overridable
2. bce.includePaths         explicit re-include, overrides 3-6
   (a directory is still descended into when a pattern like `dist/**` matches inside it)
3. bce.ignorePaths          user exclusions
4. built-in noise rules     node_modules, dist, coverage, lock files, ...
5. nested .bceignore        per directory, gitignore syntax
6. nested .gitignore        when bce.respectGitignore is true (default)
```

Implementation: `src/core/ignore/ignoreEngine.ts` (`IgnoreEngine`) plus
`src/core/ignore/patterns.ts`. Every decision is recorded with a *reason* and a *source*, so
`BCE: Show Diagnostics` and `bce_get_status` can answer "why is this file missing?" without
guesswork.

Executable specification: `test/ignore.test.ts` (secrets, nested ignore files, include
overrides, size limits, symlinks, unreadable directories) and `test/safety.test.ts` (path
traversal, absolute paths outside the root, secret leakage into tool output).

## 4. Symbolic links

* `bce.followSymlinks` defaults to `false`; links are simply not followed and reported as ignored.
* When enabled, every link is resolved with `realpath` (or the adapter equivalent) and **must**
  still resolve inside the workspace root. An escaping link is refused, recorded as an error and
  listed as ignored with the reason `symbolic link leaves the workspace and was refused`.
* Virtual file systems without real path resolution degrade to syntactic checks only, which is
  why `virtualWorkspaces` is declared unsupported in the manifest.

## 5. What leaves the machine

Only what the agent explicitly receives in a tool result, and only through your normal Copilot
connection:

* paths, symbol names, line numbers, short snippets (bounded by `bce.search.snippetLines` and
  `bce.tokenBudget`),
* never secrets, never excluded files, never binaries, never whole files unless you ask for a
  range,
* **including unsaved editor content of a dirty file you asked about**. That code has not reached the
  disk yet, but it is exactly what you are looking at, so withholding it would hand the agent stale
  code. If you do not want that, save or revert the buffer - then the disk copy (which is what the
  index holds) is used again. Every such result is labelled `UNSAVED editor buffer`.

You can inspect exactly what was sent: `BCE: Show Diagnostics` lists every tool call with the
characters and estimated tokens returned, `BCE: Show Usage Report` renders the persistent usage log
(calls, queries, estimated tokens returned and estimated naive baseline), and the output channel
logs each call at `bce.diagnostics.level: verbose`.

## 6. Storage and deletion

* Default location is VS Code extension storage, i.e. outside your project.
* Index, map and cache contain metadata and code snippets of indexed files. Treat the index
  directory like the source: it is not encrypted, so secure the machine/profile accordingly.
* The usage log (`usage.jsonl`) records the queries and paths you asked the `bce_*` tools about plus
  estimated token counts. It is local only, never uploaded, disabled with
  `bce.usageLog.enabled: false` and deleted with `BCE: Reset Usage Log`.
* Deleting it: close VS Code and remove the `bce-index` directory (or run `BCE: Clear Cache` for
  the caches only, `BCE: Reset Usage Log` for the usage log, `BCE: Rebuild Index` to regenerate). See
  [INDEX-STORAGE.md](INDEX-STORAGE.md).
* `bce.storage.location: "workspace"` writes to `<project>/.bce`. BCE then also ensures the
  managed `.gitignore` block exists, so it cannot be committed by accident.

## 7. Untrusted workspaces

In Restricted Mode (`untrustedWorkspaces: limited`):

* indexing works (read-only),
* the `.gitignore` update is skipped,
* the workspace storage location is not used.

No BCE feature requires executing project code, so there is no "trust me and I will work"
trade-off beyond the git-ignore convenience.

## 8. Reporting

This is a local development tool. If you find a case where a secret file is indexed, returned by
a tool, or where a path escapes the workspace, that is a security bug: reproduce it with
`test/fixtures/sample-project` (which intentionally contains `.env`, `config/server.key` and
`config/secrets.json`) and open an issue with the failing test.

---

Boopy Context Engine is part of the Boopy developer tooling - [boopycode.com](https://boopycode.com).
