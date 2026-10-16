---
name: 'Boopy Context Engine (BCE)'
description: 'Prefer the local BCE tools over repository-wide greps when locating code, reading one symbol, or checking what depends on a change. Also explains how to read their output honestly.'
---

# Reach for BCE before you grep

This workspace has the Boopy Context Engine extension installed. Its tools read a
local index and return ranked, token-bounded slices, so they are cheaper than
reading files "just in case" and they say what they could not see.

Order of operations:

1. Touching an unfamiliar area → `bceProjectOverview` (add `focus` for the area).
2. Looking for code by concept, feature or name → `bceFindContext`. Name the
   symbol, route, table or endpoint and add `scope` when you know the directory.
3. You know the file and need one symbol → `bceFileContext` with `path` + `symbol`.
4. Before renaming, moving, deleting or changing a signature → `bceImpact`.
   Qualify the symbol as `Class::method` when the bare name is ambiguous.
5. Before writing tests → `bceRelatedTests`, then mirror the nearest listed file.
6. Results look stale or wrong → `bceStatus` before trusting the rest.

## Read the output honestly

- `coverage:` says how much of the import graph the index could link. Below 100 %,
  an empty reference or dependent list is a hole in the index, not proof that
  nothing uses the code. Confirm with a text search before acting.
- `NOT ANALYSED` means the requested target was not resolved and no lists were
  produced on purpose. It never means "no dependents".
- Sections labelled `heuristic` or `probable` are unverified leads: open the files.
- Prefer several narrow calls over one huge one; the budgets are per response.

Never work around a BCE refusal (a secret file, or a path outside the workspace)
by pasting the contents into the chat.
