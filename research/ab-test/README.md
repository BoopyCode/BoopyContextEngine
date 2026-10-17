# A/B test harness: GitHub scout with and without Headroom

A small application plus a fair A/B harness for the transport hop in
[docs/HEADROOM-TRANSPORT.md](../docs/HEADROOM-TRANSPORT.md).

```
app/githubScout.mjs      live GitHub search, enrichment and an "interesting" score
app/tools.mjs            the agent's tools (search, repo details, read file, summarise)
shared/agent.mjs         the deterministic agent loop (identical in both arms)
shared/proxy.mjs         recording proxy: forwards to the model, or to Headroom
shared/model-server.mjs  mock model: counts prompt tokens with tiktoken, never thinks
shared/headroomLog.mjs   reads Headroom's own before/after numbers from its log
shared/report.mjs        renders the markdown report
run.mjs                  orchestrates both arms and writes runs/<label>/
```

See [RESULTS.md](RESULTS.md) for the measurements and the limits of what they prove, and
[DEEPSEEK.md](DEEPSEEK.md) for the real-model variant (`run-live.mjs`).

## Run

```powershell
pip install "headroom-ai[proxy]"     # once; the harness uses .headroom-venv
npm install tiktoken --no-save

node ab-test/run.mjs --label my-run
node ab-test/run.mjs --label my-control --control headroom-off   # must report ~0%
node ab-test/run.mjs --label my-token  --headroomMode token

# real model, real billing (needs DEEPSEEK_API_KEY)
node ab-test/run-live.mjs --label deepseek-1
```

Needs network access to `api.github.com`. Set `GITHUB_TOKEN` to lift the 60/hr limit.

## Ports

| port | who |
| ---: | --- |
| 8787 | headroom proxy |
| 8811 | mock model, direct (arm A) |
| 8812 | mock model behind Headroom (arm B) |
| 8813 | recording proxy for arm A |
| 8814 | recording proxy for arm B |

Override any of them with `--headroomPort`, `--directPort`, `--headroomModelPort`,
`--proxyAPort`, `--proxyBPort`.
