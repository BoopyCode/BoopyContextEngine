# Headroom transport: Copilot -> BCE -> Headroom -> model

```
┌──────────────────────────┐
│  Boopy Context Engine    │  project indexing, dependencies, relevant files, documentation
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│  GitHub Copilot agent    │  uses that context through VS Code tools (Bash, Read, Grep, bce_*)
└────────────┬─────────────┘
             ▼   every chat request
┌──────────────────────────┐
│  Headroom proxy          │  compresses the conversation (tool outputs, repeated turns, JSON, logs)
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│  Selected Copilot model  │  processes the optimized context
└──────────────────────────┘
```

BCE is the first box *and*, when the transport is on, the wire between the second and
the third: it registers a loopback endpoint and points Copilot's chat API at it.

## Why BCE has to sit on the wire

BCE cannot see which tools Copilot sent to the model - it only sees its own six tools.
Headroom, sitting on the wire, sees the whole conversation. That is the only place where
repeated tool output (`Read` results, `grep` dumps, logs) can be folded, and where the
compression applies to **every** tool, not just `bce_*`.

Headroom only compresses what the proxy *forwards*, not what `/v1/compress` returns:
`/v1/compress` reported `tokens_saved=0` for a long user prompt and does not keep the
per-conversation state that cross-turn dedup needs. The transport therefore forwards
requests; it never pre-compresses them.

## Turning it on

```powershell
pip install "headroom-ai[proxy]"     # CLI + proxy extras, Python 3.11+
```

1. Set `bce.headroom.transport` to `cache` (default) or `token`.
2. Run **BCE: Start Headroom Transport** (or just reload the window after changing the setting).
3. Reload the window when BCE asks: Copilot reads its endpoint override at startup.

BCE then

* starts `headroom proxy` itself (or reuses one already listening on 8787/8788),
* writes `github.copilot.advanced.debug.overrideCapiUrl` **in user settings**,
* forwards every chat request from Copilot to the proxy, adds `X-Headroom-Stack:
  vscode-copilot-bce` and `X-Headroom-Tools: <tool names seen in the request>`,
* streams the answer back unchanged,
* stops the proxy after `bce.headroom.transportIdleMinutes` without agent traffic,
* removes the override again on **BCE: Stop Headroom Transport**.

## What the transport does not do

* **It never touches the Copilot token.** The proxy is launched *without*
  `GITHUB_COPILOT_TOKEN`; Copilot keeps its own short-lived token and signs every request
  itself. BCE only routes, it does not authenticate.
* **It does not rewrite the conversation.** The request body is forwarded byte for byte.
* **It does not take Copilot down.** A stopped, refusing or slow proxy costs one failed
  hop and the request is forwarded straight to Copilot. A failure after the stream has
  started is reported in the usage log, not retried.
* **It does not fire on non-chat endpoints.** `/models`, `/embeddings`, `/agents`,
  `/skills`, `/auto` and the rest pass straight through.

## Measured

Copilot-shaped `/v1/responses` body, four `grep` tool outputs of 60 records each plus a
user message, forwarded through `headroom proxy` 0.41.0 (mode `cache`) to a fake Copilot
upstream:

| | bytes |
| --- | --- |
| what the client sent to the transport endpoint | 40,444 |
| what reached the fake Copilot | **5,636** |

Headroom replaced three of the four repeated tool outputs with
`[↑62L same as msg 0: '[60]{kind:string,...']` - lossless, reversible, and it keeps the
first copy (which sits in the prefix the provider already cached).

For a full A/B measurement on a real application (a GitHub repo-scout agent), see
[../ab-test/RESULTS.md](../ab-test/RESULTS.md): **32.4% fewer model input tokens**, and
**0%** for the same run with Headroom in passthrough mode.

Two honest caveats:

* **The transport is not a provider cache inside BCE.** Copilot sends the full
  conversation; whether GitHub's prefix cache then hits depends on Headroom's `cache`
  mode keeping earlier turns byte-identical. Measure it with `headroom savings`.
* **Only exercised with a real Copilot account can end-to-end routing be proven.** The
  unit and live tests prove the transport sends the right thing to the proxy and that the
  proxy compresses it; they cannot prove GitHub accepts the relayed request without a
  token.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `bce.headroom.transport` | `off` | `off`, `cache` (freeze earlier turns) or `token` (allow rewriting them) |
| `bce.headroom.transportPort` | `8789` | loopback port of the BCE endpoint |
| `bce.headroom.command` | `""` | `headroom` or `python -m headroom`; empty = `.headroom-venv`/`.venv` in the workspace, then PATH |
| `bce.headroom.transportIdleMinutes` | `20` | stop a proxy BCE started after this much idle time |
| `bce.headroom.transportStartupSeconds` | `45` | how long to wait for the proxy before forwarding directly |
| `bce.headroom.copilotBaseUrl` | `""` | upstream Copilot API; empty = `https://api.githubcopilot.com` |
| `bce.headroom.maxBodyKb` | `8192` | largest chat body accepted (HTTP 413 above it) |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Copilot answers a transport error | The endpoint is bound to `127.0.0.1`; Copilot may run in a remote extension host (SSH, WSL, container) that cannot reach it. Run BCE in that host or forward the port. |
| "Copilot already uses a custom API endpoint" | Another tool (or `headroom wrap vscode`) owns `overrideCapiUrl`/`overrideProxyUrl`. BCE refuses to overwrite it; set `bce.headroom.copilotBaseUrl` to force the transport. |
| Requests are forwarded straight to Copilot | The proxy did not answer. Check the BCE output channel (it logs `headroom` startup), or run `headroom proxy` by hand. |
| Enterprise host rejects models | Set `bce.headroom.copilotBaseUrl` to the host Copilot advertises for your account. |
| Port 8789 busy | Change `bce.headroom.transportPort`. |
| "Headroom proxy did not become ready" plus a process name | An old proxy is still listening. Stop that process or let BCE reuse it after it answers `/health`. |

## What BCE reports

**BCE: Show Transport Report** shows the endpoint, upstream, proxy ownership, request
counts and the `before -> after` bytes Headroom itself wrote to its log. Those numbers come
from the proxy, not from BCE's estimator. Turns travel to the usage log as
`transport_responses` / `transport_chat` entries so `BCE: Show Usage Report` can compare
them with the six `bce_*` tools - and compaction is kept separate from the naive baseline,
because the two measure different things.

## Separately: payload compaction

`bce.headroom.payloadCompaction` (default **off**) sends an individual `bce_*` tool result
to the same proxy. It is a different path from the transport and usually redundant once
the transport is on, because the proxy already sees those results inside the conversation.
Keep it off unless you run the transport off and still want the JSON in a tool result
shrunk.
