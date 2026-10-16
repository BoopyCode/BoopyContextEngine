# Benchmark

## 1. What can be measured locally, and what cannot

| Question | Locally measurable by BCE |
| --- | --- |
| Does the retriever return the right files? | yes - hit rate and rank of the first correct hit |
| How much context does a lookup cost? | yes - estimated tokens of the returned bundle |
| How much would a naive "read every candidate file" cost? | yes - estimated tokens of that file set |
| Time spent searching | yes - milliseconds per call |
| Answer quality, number of agentic steps, billed API usage | **no** - that needs a real Copilot session and provider accounting, to which an extension has no access |

BCE therefore automates the local half and labels everything else explicitly.

## 2. Running it

1. Open the project and let the index finish (`bce: Ready`).
2. Run `BCE: Run Local Benchmark`.
3. Optionally provide your own tasks in `<project>/.bce-benchmark.json`:

```json
{
  "tasks": [
    {
      "id": "refund-flow",
      "description": "Add refund support to orders",
      "query": "order refund status paid",
      "expectedPaths": ["src/services/orderService.ts", "src/models/order.ts"]
    }
  ]
}
```

Without that file, BCE derives reproducible tasks from your own project: for the largest modules
it asks for the module (expecting its files), for the first tables it asks for the migration or
schema, for the first routes it asks for the handler file.

## 3. What the numbers mean

* **hit rate** - share of tasks where at least one expected path appeared in the returned hits.
* **mean rank** - average 1-based position of the first correct hit (1.0 = always the top hit).
* **BCE tokens** - estimated tokens of the returned bundle, with snippets disabled so the
  comparison is about *finding* files, not about reading them.
* **baseline tokens** - estimated tokens of reading **every non-test file whose path or symbol
  names contain a query term** (`size / 4`). This is the honest upper bound of the naive approach
  across the same query.
* **saved %** - how much smaller BCE's context is compared to that baseline.

Nothing here is a currency amount, and no number is taken from the model provider.

## 4. Reference run (fixture project)

`test/fixtures/sample-project` - 27 indexed files, PHP + TypeScript + SQL + Python + Markdown,
budget 900 estimated tokens per task, snippets disabled, 8 tasks derived from the project itself:

```text
hit rate: 100% , mean rank of first correct hit: 1.4,
estimated context: ~1916 tokens (BCE) vs ~4792 tokens (naive baseline)  -> 60% smaller
```

Reproduce with `test/benchmark.test.ts` (`npm test`).

The saving looks modest on a 27 file fixture because the baseline only counts files whose paths or
symbols contain a query term. The baseline grows with repository size and query breadth, while the
BCE bundle stays bounded by `maxTokens` - which is exactly the property the benchmark is meant to
observe. Do not quote this ratio as a general result; run it on your own project.

## 5. The usage log: what BCE actually saved in your project

The benchmark measures a fixed task set. The **usage log** measures what really happened:

* every `bce_*` call is appended to `usage.jsonl` in BCE storage with the estimated tokens it
  returned and, where a fair naive alternative exists, the estimated tokens that alternative would
  have cost;
* `BCE: Show Usage Report` renders it; `bce_get_status --verbose` shows the running totals;
* `BCE: Reset Usage Log` clears it (use it before an experiment), `bce.usageLog.enabled: false`
  switches it off and `bce.diagnostics.level` does not affect it.

Which calls get a baseline, and which deliberately do not:

| tool | baseline |
| --- | --- |
| `bce_find_context` | estimated tokens of reading every file whose path or symbol names match a query term |
| `bce_get_file_context` | estimated tokens of reading that whole file |
| `bce_get_project_overview`, `bce_explain_impact`, `bce_get_related_tests`, `bce_get_status` | none - they replace searching or reading in ways that have no single honest "without BCE" price |

Reading the numbers honestly:

* a **negative or zero saving is possible** and is reported as such: on a small project a 300 token
  budgeted search can cost more than opening the two files the naive route would have opened. The
  report always shows both sides (returned and baseline) instead of only the difference;
* the baseline is an *upper bound*: a real agent might read fewer files and miss the answer, or read
  more and waste tokens;
* these are local estimates from a character based estimator, **not** the provider's billing, and
  they say nothing about answer quality. Only the A/B in section 6 above can speak to that.

## 6. Comparing with and without BCE in a real session
For a genuine A/B, keep everything else equal:

1. Pick three tasks of different size (one-file change, cross-module feature, refactor).
2. Run each task twice on a clean checkout: once with BCE enabled, once with `bce.enabled: false`
   (or the extension disabled) - same prompt, same model, same settings.
3. Record: number of agentic steps, tool calls Copilot made anyway (grep/read), wall-clock time,
   the provider's reported usage, and whether the result was correct.
4. Compare the quality first. A cheaper run that produces wrong code is not an improvement.

BCE cannot collect step counts or chat token usage itself; that data comes from your Copilot
session, and only then is it meaningful to compare totals.

## 7. Measured reference run (synthetic project, 0.1.2)

This run answers a narrower question: **does the extension behave the same before and after it is
installed into VS Code, and what does it cost at activation time?**

### Method

1. `node scripts/generate-project.mjs` writes a deterministic project (30 modules, 618 files on
   disk: `src/modNN/*.ts`, `app/Http/Controllers`, `app/Models`, `database/migrations`,
   `database/schema.sql`, docs, plus `node_modules/`, `dist/`, `vendor/`, `.env` and
   `config/server.key` that must never be indexed) and a `.bce-benchmark.json` with 12 tasks whose
   expected paths are known.
2. `node scripts/measure.mjs --bundle <dist/extension.js> --rounds 3` activates that bundle against
   the project through the same `vscode` stand-in the unit tests use, waits for
   `complete: true`, then drives `bce_find_context` (12 tasks x 3 passes) and the
   `BCE: Run Local Benchmark` command. Every round is a separate process with a fresh index, so no
   warm cache or retained heap leaks into the next round.
3. The same script was run for the development bundle, the production bundle
   (`npm run vscode:prepublish`) and the bundle inside the installed extension
   (`code --install-extension bce-0.1.2.vsix`).

The installed bundle and the locally built production bundle have the same SHA-256
(`D77ADEF0B0D517216D5581657EE331DD84CF1918FF5848718A6208763B434F7B`), so the comparison below is
behaviour of identical code in two locations, not two code versions.

### Result

| Metric | dev build | production build | installed extension |
| --- | --- | --- | --- |
| bundle size | 1 031 KB (inline sourcemap) | 150 KB | 150 KB |
| files indexed | 577 | 577 | 577 |
| ignored paths | 8 (whole `node_modules`, `dist`, `vendor`, `.bce*` pruned) | 8 | 8 |
| index run, median of 3 rounds | 5 957 ms | 4 801 ms | 1 932 ms |
| index run, individual rounds | 5 957 / 8 155 / 2 329 ms | 4 801 / 3 802 / 5 260 ms | 1 932 / 1 614 / 2 136 ms |
| activate + first index | 6 042 ms | 4 894 ms | 2 062 ms |
| `bce_find_context` p50 | 0.7 ms | 1.3 ms | 0.9 ms |
| first `bce_find_context` call (cold) | 348 ms | 414 ms | 247 ms |
| heap after index | 13.7 MB | 10.8 MB | 11.8 MB |
| RSS | 56.5 MB | 55.3 MB | 55.2 MB |
| hit rate (12 tasks) | 92 % | 92 % | 92 % |
| mean rank of first correct hit | 1.9 | 1.9 | 1.9 |
| estimated context, all 12 tasks | ~8 634 tokens vs ~171 270 baseline (95 % smaller) | same | same |

Across all nine rounds the index run ranged from 1 614 ms to 8 155 ms (median 3 802 ms), heap after
index 10.5 - 14.0 MB, RSS 55 - 58.7 MB, and the cold first search call 189 - 822 ms. The per-task
results (ranks, found/missing, token estimates) were byte-identical in all nine runs.

### What the comparison does and does not show

* **Equivalent behaviour.** Hit rate, mean rank, token estimates, indexed file count and the
  per-task output are identical everywhere, and the installed bundle is the same file hash. So
  installing the extension (VSIX packaging included) does not change what the tools answer.
* **Packaging cost.** Only the artifact changes: 1 031 KB development bundle -> 150 KB production
  bundle -> 84 KB VSIX (14 files, installed into VS Code).

The machine was not otherwise idle during these runs, which is the main reason the timing rows move
so much between rounds.
* **Timing differences are noise.** The installed round was the fastest only because it was the last
  one measured; the same build measured 1.6 s and 5.3 s in different rounds, and the development
  build measured 2.3 s and 8.2 s. Do not read the index-run column as a comparison — on a shared
  machine, cold file cache dominates.
* **Cold vs warm.** The first `bce_find_context` after activation costs 0.2 - 0.5 s (module warm-up
  plus the first ranking pass), every later call is ~1 ms.
* **Still not measured:** answer quality, agent step count and billed usage. Those need a real
  Copilot session (section 6).
* **One honest miss.** `test-lookup` ("Service04_0 test compute", expecting
  `tests/mod04/service0.test.ts`) is not returned inside the 12-hit window: the six
  `src/mod04/service*.ts` implementations that define the symbol outrank it. The top hit still
  carries a `tests: tests/mod04/service0.test.ts` pointer, and `bce_get_related_tests` returns the
  test file directly, but a query that names an implementation symbol is a poor way to ask for
  tests.

Reproduce with:

```powershell
node scripts/generate-project.mjs "$env:TEMP\bce-bench-project"
npm run vscode:prepublish
node scripts/measure.mjs --bundle dist/extension.js --label prod-build --rounds 3
node scripts/measure.mjs --compare .bce-measure-dev-build.json .bce-measure-prod-build.json
```

Raw per-round results are written to `.bce-measure-<label>.json` (git ignored).

The same run on 0.1.3 reproduces the functional numbers exactly (577 files indexed, 8 ignored path(s),
92 % hit rate, mean rank 1.9, ~8 634 vs ~171 270 estimated tokens); only the timing rows move, as
described above.

## 8. Impact analysis on a real PHP repository (0.1.7)

Sections 7 and 6 measure search cost and behaviour consistency. Neither could have caught the two
bugs below, because both produced a *well-formed, confident, wrong* answer rather than an error. What
found them was running the tool on a real project and comparing the output against what the code
actually does: `PaymentService::delete()` has five callers, and 0.1.6 reported

```
verified parser references (0) - these are safe to trust:
  (none found)
```

### Method

The `boopyinvoice` repository (301 indexed files, 193 PHP) was indexed with the harness in
`test/support/harness.ts` and `bce_explain_impact` was asked for `PaymentService::delete`. The
expected callers are known independently, by text search:

| Caller | Kind |
| --- | --- |
| `backend/src/Controllers/InvoiceController.php:454` | production |
| `backend/src/Services/BankStatementService.php:404` | production |
| `backend/src/Services/CashRegisterService.php:728` | production |
| `backend/tests/sprint2-payments-reminders.php:125` | test |
| `backend/tests/sprint23-cash-register.php:326` | test |

### Result

| Version | `verified parser references` (only the known five counted) | `coverage:` | Import graph |
| --- | --- | --- | --- |
| 0.1.6 | 0 of 5 | not reported | 0 of 168 `use App\...` imports linked |
| 0.1.7, resolver only | 5 of 5 | `75 % (100/407 unresolved)` | namespaces linked, vendor namespaces still counted as holes |
| 0.1.7 final | 5 of 5 | `100 % (0/307 unresolved)`, 22 references, 6 dependents | 307 of 307 internal imports linked |

Two independent causes, each enough on its own to hide the callers:

1. **`delete` was filtered as a keyword.** The reserved word list was shared between languages and
   contained the JavaScript keyword `delete`, so every PHP reference named `delete` was dropped
   during parsing - before any analysis ran. Each parser now has its own list.
2. **PHP namespaces were never resolved.** `composer.json` `autoload.psr-4` was not read, so
   `App\Services\PaymentService` was guessed as `App/Services/PaymentService.php`; in this layout the
   real path is `backend/src/Services/PaymentService.php`. All 168 imports failed, and the dependency
   graph then classified every one of them as an *external package* - so the index still reported
   `complete: true`.

The second row of the table is the useful one: installing the resolver alone produced `coverage: 75 %`
rather than `100 %`, because a namespace whose root was unknown was counted as an internal hole. Real
projects contain both, and the first version of the fix over-reported. That number is what exposed it.

### What this run says about the benchmark suite

* **A benchmark suite that only measures cost cannot find a wrong answer.** Every existing metric
  (files indexed, hit rate, mean rank, estimated tokens) was healthy while the impact tool was
  returning nothing.
* The regression is now covered by `test/impact.test.ts`, which builds a miniature PHP project with a
  `backend/composer.json`, so the two causes cannot come back unnoticed.
* **Still not measured:** how many *agent* steps the correct impact answer saves. That remains the
  A/B in section 6, and it is the measurement that would justify the tool on grounds other than
  correctness.

---

Boopy Context Engine is part of the Boopy developer tooling - [boopycode.com](https://boopycode.com).

