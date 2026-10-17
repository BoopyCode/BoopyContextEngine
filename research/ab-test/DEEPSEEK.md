# DeepSeek: real end-to-end A/B

The mock run ([RESULTS.md](RESULTS.md)) isolates compression. This one is the honest
end-to-end variant: a real model chooses its own tool calls, and the token numbers come
from the **provider's billing**, not from a local estimator.

## What it needs

| | |
|---|---|
| Key | `DEEPSEEK_API_KEY` in the environment (never written to disk, never logged) |
| Model | `--model deepseek-chat` (default) or any id your key can call |
| Base URL | defaults to `https://api.deepseek.com` |

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."          # from platform.deepseek.com/api_keys
pip install "headroom-ai[proxy]"          # once; harness expects .headroom-venv
npm install tiktoken --no-save

node ab-test/run-live.mjs --label deepseek-1
```

Arm A calls DeepSeek directly. Arm B calls a **fresh** Headroom proxy, which is started
with `OPENAI_TARGET_API_URL=https://api.deepseek.com/v1/chat/completions` so it forwards to
DeepSeek instead of OpenAI. That variable is required: without it Headroom sends the body
to `api.openai.com` and your DeepSeek key is rejected there.

## Why this needs no Copilot login

Your DeepSeek setup reaches VS Code through the extension `vizards.deepseek-v4-for-copilot`,
which posts to `${deepseek-copilot.baseUrl}/chat/completions`, streams SSE and asks for
`stream_options.include_usage`. The BCE transport exposes the same contract, so

```json
"deepseek-copilot.baseUrl": "http://127.0.0.1:8789"
```

puts Headroom on the path with your existing DeepSeek key — no `headroom copilot-auth login`,
no Copilot subscription, no change to the extension.

That mapping is verified, not assumed: `node ab-test/check-vscode-path.mjs` replays the
extension's exact request shape through the built transport and reports

```
endpoint:        http://127.0.0.1:8789/chat/completions
status:          200
content-type:    text/event-stream
sse chunks:      4
has tool call:   true
override lifecycle: override=http://127.0.0.1:8789 -> override=(cleared)
```

One caveat: an endpoint override applies to **all** VS Code chat models, not just DeepSeek.
If you use several providers, either keep the transport on only while working with DeepSeek, or
set `bce.headroom.copilotBaseUrl` to the provider you want on the far side.

## Real DeepSeek run: what actually happened

Run on 2026-10-17 with `deepseek-chat`, a real key, and the agent allowed to choose its own
tool calls (`node ab-test/run-live.mjs --label deepseek-real`).

### Result: no saving, and one clear warning

| metric | arm A (direct) | arm B (Headroom) | change |
| --- | ---: | ---: | ---: |
| prompt tokens | 15,440 | 16,784 | **+8.7% (worse)** |
| cache hits | 10,240 | 11,520 | |
| cache misses | 5,200 | 5,264 | +1.2% |
| completion tokens | 993 | 1,033 | +4% |
| list cost | $0.0019 | $0.0019 | +2.6% |

Two separate things are visible in the per-turn table, and they must not be mixed:

1. **The trajectories diverged.** By turn 2 arm B called `read_file` where arm A called
   `repo_details`, so the two arms sent different conversations. The totals are therefore
   *not* comparable — the +8.7% is mostly a different task, not worse compression.
2. **DeepSeek's own prefix cache is doing the heavy lifting already.** 66% of both prompts
   were cache hits, billed at ~1/30 of the miss price.

### The clean measurement (same conversation, both paths)

To remove the trajectory variable, `ab-test/compare-same-conversation.mjs` sends **one
fixed 19 KB conversation** through both paths and reads the provider's usage:

```
usage direct:   {"prompt_tokens":5938,"completion_tokens":64,
                 "prompt_cache_hit_tokens":5760,"prompt_cache_miss_tokens":178}
usage headroom: {"prompt_tokens":5938,"completion_tokens":476,
                 "prompt_cache_hit_tokens":5760,"prompt_cache_miss_tokens":178}
```

**Prompt tokens: identical. Cache hits: identical. Cost of input: identical.**

Headroom's log for that request shows why: `route_counts={'cache_hit': 1}` — in `cache`
mode it deliberately leaves a request alone when it recognises a cached prefix. That is the
right behaviour (it protects provider caching) but it also means **`cache` mode gives you
nothing on DeepSeek's `/chat/completions` path**, where DeepSeek already auto-caches.

### What this means for you

* **Do not assume a saving.** The mock showed 32.4% because the mock has no prefix cache and
  its tool outputs were repeated JSON. DeepSeek prices cache hits at a fraction, so the real
  baseline is already cheap.
* **The gain, if any, comes from the first send.** Headroom can only help when a request is
  *not* already served by the provider cache: a fresh session, changed earlier turns, or
  output that DeepSeek's own cache does not cover.
* **`token` mode is the lever worth testing**, because it is allowed to rewrite earlier turns:

  ```powershell
  node ab-test/run-live.mjs --label deepseek-token --headroomMode token
  ```

  It trades cache hits for a smaller prompt; on DeepSeek that trade is usually bad unless the
  saving is larger than the cache discount (about 30x).
* **Completion tokens went up** in the paired run (64 -> 476). One sample is not a trend, but
  a longer answer is a real cost at $0.66/M and it belongs in any honest comparison.

**Verdict for a tool-heavy agent on DeepSeek: the transport is not a token saver today.**
It is worth keeping for the other providers and for sessions where the provider cache misses,
but the honest recommendation is to measure with `run-live.mjs` on your own workload before
leaving it enabled.

Start the bundled fake DeepSeek (streaming, with DeepSeek-style `usage` including
`prompt_cache_hit_tokens`) and run the harness against it:

```powershell
node ab-test/shared/fake-deepseek.mjs 8820
$env:DEEPSEEK_API_KEY = "test-key"
node ab-test/run-live.mjs --label live-selftest --baseUrl http://127.0.0.1:8820
```

Verified result of exactly that run (2026-10-17, Headroom 0.41.0):

| metric | arm A (direct) | arm B (Headroom) | difference |
| --- | ---: | ---: | ---: |
| prompt tokens | 2,694 | 1,627 | **39.6% fewer** |
| list cost | $0.0006 | $0.0004 | 37.4% cheaper |
| answers | identical | identical | - |

The fake emits the same trajectory in both arms, so this number validates the *harness and
the transport path*, not DeepSeek's real behaviour. Run it with your key to get the real one.

## Reading the real result

The live report prints provider `usage.prompt_tokens`, the DeepSeek cache split
(`prompt_cache_hit_tokens` vs misses, priced separately), per-turn tool calls and both
answers verbatim. Read the per-turn table before quoting a total: with a real model the
two arms may take different paths, and a longer conversation is a task difference rather
than a compression effect.

Note that DeepSeek bills cache hits at ~1/30th of the miss price. Headroom's `cache` mode
freezes earlier turns precisely to keep those hits; `token` mode may rewrite them and trade
cache hits for a smaller prompt. Compare both before choosing:

```powershell
node ab-test/run-live.mjs --label deepseek-cache --headroomMode cache
node ab-test/run-live.mjs --label deepseek-token --headroomMode token
```
