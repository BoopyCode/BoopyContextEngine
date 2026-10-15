# Workflows: using BCE for documentation and test generation

BCE exists to feed the agent *targeted* context. These are the two workflows where that pays off
most, and both are measurable with `BCE: Run Local Benchmark` and `BCE: Show Diagnostics`.

## 1. Writing documentation for an existing project

**Goal:** produce a README/architecture document that matches the code, without reading the whole
repository.

```text
1. bce_get_project_overview              -> languages, frameworks, entry points, modules, DB objects, routes
   (optionally with focus: "api" | "database" | "tests" | "config" | "<module>")

2. bce_find_context query:"<topic>" scope:"<module>" includeSnippets:false
   -> ranked paths + line numbers; use it to decide what to read, not to read everything

3. bce_get_file_context path:"..." symbol:"..."      (only for the parts you actually document)
   -> one symbol body, its imports and dependents

4. bce_get_status                                    (optional, to prove the doc is based on a fresh index)
```

Example prompt (Agent mode):

> Use the BCE project overview and then `bce_find_context` (do not read whole files) to write
> `docs/ARCHITECTURE.md` for this project: layers, entry points, data flow between modules, the
> database tables with their columns, and the HTTP routes. Cite `path:line` for every claim and
> list anything you could not verify.

Practical notes:

* The map files (`map/project-overview.json`, `map/database-schema.json`, `map/entry-points.json`,
  `map/dependencies.json`, `map/modules.json`) are already a machine readable documentation
  skeleton - `BCE: Show Project Map` renders it, and the JSON can be committed to your docs
  pipeline if you want a generated section that never drifts.
* Ask the agent to mark `heuristic` findings (routes, framework hints) as "detected" rather than
  "verified", because that is exactly what the index says.
* Documentation changes need no BCE re-run; the doc files themselves are indexed as `doc` kind and
  appear in the overview under *project instructions*.

## 2. Generating test code

**Goal:** add tests that follow the project's existing conventions and land in the right place.

```text
1. bce_get_related_tests path:"src/services/orderService.ts"
   -> existing tests bound by convention/import/usage + runner hints (vitest, phpunit, pytest, ...)

2. bce_get_file_context path:"tests/orderService.test.ts"
   -> read the *nearest existing test* to copy its structure (frameworks, imports, naming)

3. bce_get_file_context path:"src/services/orderService.ts" symbol:"refund"
   -> the exact behavior to test, instead of the whole file

4. bce_explain_impact symbol:"refund"    (optional)
   -> which callers exist, so the test can use realistic inputs
```

Example prompt (Agent mode):

> Using `bce_get_related_tests` and `bce_get_file_context`, write a test for the refund flow that
> follows the conventions of the existing tests in this project. Put the file where the convention
> says, reuse the existing setup/mocking style, and tell me the exact command to run it.

Practical notes:

* `bce_get_related_tests` reports candidates with a confidence level and never claims coverage;
  treat a missing entry as "no test found", not as "no code path exists".
* If the runner is ambiguous, the *runner hints* section lists the detected frameworks and
  configuration files (`vitest.config.ts`, `phpunit.xml`, `pytest.ini`, ...) - use those paths
  instead of guessing the command.
* After adding tests, the watcher re-indexes them, so `bce_get_related_tests` immediately reflects
  the new binding on the next call.

## 3. Everyday flows

| Situation | Tool sequence |
| --- | --- |
| Unfamiliar codebase, feature request | `bce_get_project_overview` -> `bce_find_context` -> `bce_get_file_context` |
| "Where is X implemented?" | `bce_find_context` (returns paths, lines, why) |
| Before refactoring a symbol | `bce_explain_impact` (verified vs heuristic) -> `bce_get_related_tests` |
| Before deleting a table/route | `bce_explain_impact` -> `bce_get_file_context` on each verified reference |
| One-file edit you already have open | no BCE tool - just edit |
| Results look stale | `bce_get_status`, then `BCE: Analyze Project` if needed |

## 5. Preventing duplicate retrieval (BCE vs Copilot's own context)

Copilot Agent assembles context on its own: it may grep, read files and attach them to the prompt
before or while it calls any tool. With BCE available, that implicit retrieval is often redundant
work - the same code gets paid for twice.

What BCE does about it:

* every `modelDescription` states that the tool is the primary context source and that implicit
  attachment is redundant ("PRIMARY CONTEXT SOURCE - ALWAYS use this tool to locate code … prefer
  it over attaching or pasting entire files"),
* `bce_find_context` returns exact `path:line` ranges, so the agent can read only those instead of
  pulling whole files,
* results carry their own provenance (index version, cache hit, dirty buffers), so the agent can
  tell whether a second lookup would even add anything.

What you should do:

* On non-trivial tasks, name the tool in the prompt:
  *"fix this bug, use the BCE tools for impact analysis and context"*.
* Reference a tool explicitly with `#bceFindContext` / `#bceProjectOverview` when you already know
  what you want.
* Once you have context, ask for the change - not for "more context". If the answer is missing
  something, request a narrower query (`scope`, symbol name) rather than a bigger token budget.

Honest caveat: BCE cannot force a tool call and cannot disable Copilot's own retrieval. The savings
therefore depend on the agent's behaviour; the local benchmark measures how much context BCE returns,
not how the model decides to use it.

## 6. A reusable prompt file

`prompts/bce-context.prompt.md` in this repository wraps the "gather context first" pattern. Copy
it into your project's `.github/prompts/` directory (or your user profile prompts folder) and run
it as `/bce-context` in Copilot Chat. It instructs the agent to start with the overview, use
`bce_find_context` instead of repository-wide greps, and to report which index version the answer
came from.

## 7. Guardrails worth keeping

* Cap context: prefer two `bce_find_context` calls with narrow scopes over one huge one.
* Keep `bce.tokenBudget` low for exploration (1000-2000) and higher when writing documentation
  (4000-6000).
* When BCE refuses a path (`safety block`, `outside the workspace`), do not try to work around it
  by pasting file contents into the chat - the block is there to protect secrets.

---

Boopy Context Engine is part of the Boopy developer tooling - [boopycode.com](https://boopycode.com).
