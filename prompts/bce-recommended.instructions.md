---
name: 'Boopy Context Engine (BCE)'
description: 'Use the local BCE tools before grepping the repository. Covers when each tool applies, and how to read coverage and NOT ANALYSED honestly.'
applyTo: '**'
---

# Reach for BCE before you grep

This workspace has the Boopy Context Engine extension installed. Its tools read a
local index and return ranked, token-bounded slices, so they are cheaper than
reading files "just in case" and they say what they could not see.

## Hard rule (added by bce.enforceContextFirst)

When `bce.enforceContextFirst` is on, the same rule is appended to every BCE tool
result. It is a prompt, not a gate: VS Code gives an extension no hook before
another tool runs, so BCE cannot refuse a `grep`.

Before the first `grep`, `glob` or whole-file read in an area you have not already
read in this session:

1. Call `bceFindContext` with `symbolsOnly: true`.
2. Read only the `path:line` ranges it names, using `bceFileContext`.
3. Read a whole file only when it is under 200 lines, or when BCE returned nothing.

A BCE result is not proof. An empty or truncated bundle, or `coverage:` below
90 %, must be checked with a text search before you state that code does not exist.

Order of operations:

1. Touching an unfamiliar area → `bceProjectOverview` (add `focus` for the area).
2. Looking for code by concept, feature or name → `bceFindContext`. Name the
   symbol, route, table or endpoint and add `scope` when you know the directory.
   - Expecting to need more than one lookup → pass `symbolsOnly: true` first. It
     returns a cheap ranked `path:line` index with no code bodies and ranks several
     times more candidates for the same budget; read the one or two targets you
     picked with `bceFileContext`. This two-phase habit is the single biggest saving.
3. You know the file and need one symbol → `bceFileContext` with `path` + `symbol`.
4. Before renaming, moving, deleting or changing a signature → `bceImpact`.
   Qualify the symbol as `Class::method` when the bare name is ambiguous.
5. Before writing tests → `bceRelatedTests`, then mirror the nearest listed file.
6. Results look stale or wrong → `bceStatus` before trusting the rest.

## Read the output honestly

- `coverage:` says how much of the import graph the index could link. Below 100 %,
  an empty reference or dependent list is a hole in the index, not proof that
  nothing uses the code. Confirm with a text search before acting.
- In a `why:` line, "is exactly" and "is named after its own file" are strong
  signals; "contains" is the weakest and deserves an open file before you trust it.
- `NOT ANALYSED` means the requested target was not resolved and no lists were
  produced on purpose. It never means "no dependents".
- Sections labelled `heuristic` or `probable` are unverified leads: open the files.
- Prefer several narrow calls over one huge one; the budgets are per response.

## Quote savings honestly

The usage report gives a **range**, because the top end is a naive upper bound
(reading *every* file whose path or symbol names match the query) - not a
measurement. When you report a saving:

- quote the range, not the single highest percentage;
- say the top end is an upper bound;
- check the retrieval quality table first: a query that returns nothing saves
  100 % of its tokens and answers nothing.

Never work around a BCE refusal (a secret file, or a path outside the workspace)
by pasting the contents into the chat.
