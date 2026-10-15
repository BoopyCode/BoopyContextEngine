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
   - set `includeSnippets: false` when you only need paths and line numbers.
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
- Open only the ranges the tools returned. Do not attach or paste whole files "for safety" - that
  duplicates the context you just paid for.
- If a file has unsaved changes, the tool output says so (`UNSAVED editor buffer`) and its line
  numbers refer to the buffer. Ask the user to save before you apply an edit based on stale line
  numbers.
- Never work around a BCE refusal (secret file, path outside the workspace) by pasting contents
  into the chat.
- Report at the end: which files you touched, and which BCE index version your context came from.
