# Who saves what: BCE vs Headroom

Measured on the blog in this folder (`node blog/src/build.mjs`), with one tokenizer
(tiktoken, `cl100k_base`) and one price list (DeepSeek V4 Flash) for every row.

## The answer in one table

| step | prompt tokens | cost | what happened |
| --- | ---: | ---: | --- |
| naive: an agent opens everything | **1,068,248** | $0.2350 | 112 project files + tree listings + 12 whole repositories |
| after **BCE** | **8,013** | $0.001763 | index, ranked hits, one exact slice |
| after **BCE + Headroom** | **5,890** | $0.001296 | the same nine BCE calls, compressed |

| | tokens saved | % smaller | share of the total |
| --- | ---: | ---: | ---: |
| **BCE** | 1,060,235 | **99.2%** | essentially all of it |
| **Headroom** (on BCE's output) | 2,123 | 26.5% (of BCE's 8,013) | 0.2% |

And Headroom on its own, on a payload it can actually work with (a CI log with a repeated
stack trace plus a 60-row JSON dump):

```
6,712 -> 4,212 tokens  (37.2% smaller, 1,774 ms)
```

## What the numbers mean

**BCE does the work because it prevents the reading, not because it compresses.**
99.2% is not a compression ratio: it is 1.06M tokens of files that were never opened. That is
the whole point of an index - you cannot compress what you never read.

**Headroom only helps with the last mile.** 26.5% of what BCE still returns is real (2,123
tokens), and 37.2% on a log dump that carries repetition. But on BCE's own output it moves
0.2% of the total, because BCE already returns pre-ranked slices: short, dense, code-heavy -
exactly what Headroom deliberately leaves alone.

**Both are small relative to the naive path.** After BCE, even a 40% compression of the
remainder saves a fraction of a cent. DeepSeek's own prefix cache does more for the
*repeated* cost, since 66% of a warm prompt bills at ~1/30 of the miss price.

## Honest limits

* The naive baseline prices 12 whole repositories by their GitHub-reported size
  (`size × 1024 / 3.6`). That is an estimate, and it is the largest single contributor
  (873,816 of the 1,068,248 tokens). The direction is certain - opening whole repos costs
  orders of magnitude more - but the exact percentage moves with repository size.
* The blog project itself (112 files) is measured on disk, exactly.
* The BCE arm runs the real handlers over a real index of this repository plus live GitHub
  data, so its 8,013 tokens are measured, not modelled.
* Headroom figures come from a real proxy (0.41.0) in `cache` mode, one run each. Compression
  ratios vary with how repetitive the payload is.
* Nothing here measures answer quality. A cheaper context that omits the file the agent
  needed is not a saving - that is why BCE reports hit counts and coverage next to its tokens.

## Reproduce

```powershell
node blog/src/build.mjs 4            # build the blog from live GitHub
npx tsx blog/measure/run.mjs         # the three-arm measurement
```

`result.json` next to the script holds every per-call number.
