# research-demo (Atlas fixture, plan §18)

A research app: the web page accepts a topic, the API queues a job, and the worker runs two tools
(search, summarize) and writes a report (JSON + PNG chart + HTML). Everything is local and fake:
no network, accounts or real user data. Atlas analyzes this tree without running it; the demo runs
the worker explicitly through `atlas run` and the web page through the Playwright capture helper.

```bash
atlas run --output out/report.json --output out/chart.png --output out/report.html -- \
  node worker/generate-report.mjs --topic "solar storage" --out out
```

`--sources 2` produces a report that fails the "at least 3 sources" assertion while the process
still exits 0, to show task outcome separately from process outcome.
