---
mode: agent
description: Gather BCE project context before implementing or documenting a change
---

# Context first with Boopy Context Engine

Use the local BCE tools before reading files, and keep the context small.

1. Call `bce_get_project_overview` (optionally with `focus` for the area you are about to touch:
   `api`, `database`, `tests`, `config`, `frontend`, or a module name).
2. Call `bce_find_context` with a *specific* query for the task. Do not search the whole
   repository with grep first, and do not read files "just in case".
   - narrow it with `scope` when you already know the area,
   - reduce `maxTokens` for exploration, raise it when writing documentation,
   - set `includeSnippets: false` when you only need paths and line numbers,
   - set `symbolsOnly: true` for an unfamiliar area: it returns a cheap ranked list of
     `path:line` targets with no code bodies, ranks several times more candidates for the
     same budget, and you then read the one or two you picked with `bce_get_file_context`.
     That two-phase habit is what keeps a broad search from costing a whole file's context.
   - read the `coverage:` line in the answer. Below 100% linked imports, an empty result is a
     hole in the import graph, not proof that the code does not exist.
3. Read only what you still need with `bce_get_file_context`
   (`path` + `symbol`, or an explicit `startLine`/`endLine` range).
4. Before changing shared code, call `bce_explain_impact` and treat the
   "heuristic" section as unverified.
5. Before writing tests, call `bce_get_related_tests` and mirror the nearest existing test file.
6. If results look outdated, call `bce_get_status` and say so in your answer, then ask the user to
   run `BCE: Analyze Project` if the index is stale.

Rules:

- Never claim more than the data says: parser results are labelled `exact` or `heuristic`, and
  token numbers are estimates, not the model provider's billed counts.
- When you quote the token saving from the usage report, quote it as a **range** and say that its
  top end is a naive upper bound. A single "97% smaller" figure is the best case, not the measured
  case, and a query that returns nothing saves 100% of its tokens while answering nothing - check
  the retrieval quality table before presenting a saving as a win.
- Do not treat a ranked hit as proof. Open the listed ranges before editing, especially when the
  hit's `why:` line says "contains" rather than "is named after its own file".
- Open only the ranges the tools returned. Do not attach or paste whole files "for safety" - that
  duplicates the context you just paid for.
- If a file has unsaved changes, the tool output says so (`UNSAVED editor buffer`) and its line
  numbers refer to the buffer. Ask the user to save before you apply an edit based on stale line
  numbers.
- Never work around a BCE refusal (secret file, path outside the workspace) by pasting contents
  into the chat.
- Report at the end: which files you touched, and which BCE index version your context came from.
