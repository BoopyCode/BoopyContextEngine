# A/B test: does the Headroom transport actually save tokens?

**Short answer: yes — 32.4% fewer input tokens on a tool-heavy coding-agent conversation,
reproducibly, and 0% for the passthrough control.**

The test application is a small GitHub scout: it searches the public GitHub API, enriches
the top repositories (README, languages, tags, commits), scores how "interesting" each one
is, and recommends three. A deterministic agent then works on it with `github_search`,
`repo_details`, `read_file` and `summarize_results` tools — the same shape of traffic Copilot
produces, i.e. a growing pile of tool output.

## Method

```
arm A:  agent -> recording proxy -> mock model          (no compression)
arm B:  agent -> recording proxy -> headroom -> mock model (compression)
```

Everything that could make the comparison unfair is held constant:

| Held constant | How |
| --- | --- |
| GitHub data | One snapshot captured before either arm runs; both arms read it |
| Agent trajectory | A fixed plan (search → details → search → summary → read code → answer) |
| Request bodies | Byte-identical in both arms (asserted in the report) |
| Proxy session | A **fresh** `headroom proxy` process for arm B; nothing is inherited from arm A |
| Measurement | tiktoken (`cl100k_base`) on the **body that arrived at the model**, after both hops |

The mock model never chooses a tool call, so it cannot change the conversation; it only
counts what arrived. That isolates compression, which is the variable under test.

### The control that makes it credible

`--control headroom-off` runs arm B through Headroom in passthrough mode (`--no-optimize`).
On the identical snapshot it reports **0%**:

| run | arm A | arm B | result |
| --- | ---: | ---: | ---: |
| `control-off` (passthrough) | 31,471 | 31,471 | **0%** |
| `final-cache` (mode cache) | 31,471 | 21,268 | **32.4% smaller** |
| `final-token` (mode token) | 31,471 | 21,268 | **32.4% smaller** |

A harness that reported savings with compression disabled would be measuring its own
bookkeeping, not Headroom.

## Results

Headroom 0.41.0. The same GitHub snapshot: 8 repositories, 88.7 KB of raw API output over
10 calls. Eight turns, 7 tool results in the final conversation, 110.9 KB sent by the agent.

| metric | arm A (direct) | arm B (Headroom) | difference |
| --- | ---: | ---: | ---: |
| **input tokens the model counted** | **31,471** | **21,268** | **32.4% smaller** |
| request bytes sent by the agent | 110.9 KB | 110.9 KB | identical by design |
| client-side tokens | 33,273 | 33,273 | 0% (same conversation) |
| tool results / tools called | 7 / all four | 7 / all four | identical |

Per turn, the saving grows as tool output piles up and stays once it is there:

| # | tool | model A | model B | delta |
| ---: | --- | ---: | ---: | ---: |
| 2 | `repo_details` (JSON) | 1,908 | 1,104 | 42.1% |
| 4 | `summarize_results` | 3,705 | 2,133 | 42.4% |
| 6 | `read_file` | 5,480 | 3,787 | 30.9% |
| 8 | answer | 7,173 | 5,359 | 25.3% |

What Headroom did (its own log): `mixed` (JSON/text compaction) on most turns,
`smart_crusher` on one, `none`/`noop` where nothing was compressible. Its per-request totals
(7,532 tokens) differ from the model-side total (10,203) because the proxy counts per request
before provider-side framing; the model-side number is the one a user is billed for.

## Honest limits

* **The model is mocked.** No provider credential was available, so "same answers" could not
  be measured on a real model. The agent's trajectory is fixed, which is what keeps the
  comparison fair, but it also means this measures *compression*, not *task quality*.
* **One application, one conversation shape.** A JSON/tool-output-heavy agent benefits; a
  session that only reads source code will not (Headroom leaves code alone).
* **`cache` and `token` mode produced identical numbers here** because a fresh proxy per arm
  has no earlier turns to freeze or rewrite. A long-lived session would separate them.
* Provider prompt caching is not modelled: the mock bills every prompt token at face value.

## Reproduce

```powershell
pip install "headroom-ai[proxy]"          # CLI (the harness expects .headroom-venv)
npm install tiktoken --no-save            # real tokenizer for the measurement
node ab-test/run.mjs --label my-run
node ab-test/run.mjs --label my-control --control headroom-off
```

Each run writes `ab-test/runs/<label>/`: `report.md`, `report.json`, `snapshot.json`,
and the per-arm wire logs (`arm-a.jsonl`, `arm-b.jsonl`, `model.jsonl`).

Requires network access to the public GitHub API (60 requests/hour unauthenticated; set
`GITHUB_TOKEN` to raise it).
