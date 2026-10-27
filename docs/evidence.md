# Execution evidence: runs, events, artifacts

Implements plan §10-11. The store is `packages/evidence`, the daemon routes are in `apps/daemon/src/routes/runs.ts`, and the preview origin is `apps/daemon/src/preview.ts`.

## Model

- **Run.** One execution: a command, a browser journey, or an agent session.
  - Process outcome (`status`, `exitCode`, `signal`) is stored separately from task outcome, which is derived from assertions. A run that exits 0 with a failed assertion is shown as process succeeded, task failed.
- **Event.** Immutable and append-only; database triggers forbid UPDATE and DELETE.
  - Deduplicated on `(producerId, producerEventId)`, so a duplicate delivery returns the stored event's ID.
  - Out-of-order delivery is normal. Order uses the producer `sequence`, never cross-machine timestamps.
  - Parent references to events that have not arrived are reported as `missingParents`.
- **Artifact.** Content-addressed bytes plus metadata.
  - A record is reserved first, so events can reference pending artifacts. Bytes then stream in and are verified against the declared SHA-256 and size.
  - The real media type is sniffed from magic bytes and never trusted from the producer.
  - Identical bytes are stored once, and the default limit is 100 MiB.
  - A failed upload or a declared capture failure leaves the record in `bytesState: missing` with the reason. It is never dropped.
- **Assertion.** Extracted from `assertion.result` events (`pass`, `fail` or `unknown`, with a description and optional subject artifact).
- **Correlation.** Explicit `entityRefs` on events become `supported` correlations, with runtime-event evidence.

## Snapshot binding

When a run is created, the daemon computes the digest of the worktree as it is on disk.

- If the latest snapshot has the same digest, the run binds to it.
- Otherwise a scan is queued, and the run binds when a snapshot with exactly that digest is published.

A run is never attached to a snapshot of a different (dirty) tree. Runs keep their snapshot forever, so outputs are always shown against the code that produced them.

## Credentials

Creating a run returns a per-run `ingestToken`; only its SHA-256 is stored. The token authorizes, for that run only:

- `POST /runs/:id/events`
- `POST /runs/:id/artifacts`
- `PUT /artifacts/:id/content`
- `POST /artifacts/:id/missing`
- `POST /runs/:id/finish`

It is sent as `X-Atlas-Run-Token` and unlocks nothing else. Instrumented processes receive a run token, never the daemon token.

## Isolated preview origin

Artifact bytes are never served from the app origin, which holds the UI token in sessionStorage. The daemon runs a second loopback server on the preview port, published in the discovery record.

- Bytes are only served through `GET /a/:artifactId?exp=&sig=`, an HMAC-signed URL valid for 10 minutes. The app requests these through `GET /api/v1/artifacts/:id/preview-url`.
- Responses always carry `X-Content-Type-Options: nosniff`, the sniffed content type and `Cross-Origin-Resource-Policy: same-site`.
- Their CSP includes:
  - `sandbox` (active HTML/SVG also gets `allow-scripts`, but never `allow-same-origin`, so the document is an opaque origin even when opened directly).
  - `connect-src 'none'` and `form-action 'none'`: no network.
  - `frame-ancestors` limited to the app origin.
- The UI's own CSP allows frames, images and media only from the preview origin.
- Host checks apply on both ports.

## Recovery and limits

On daemon start, runs still `running` become `interrupted` with a capture gap. A later finish is accepted and recorded as `late-finish`.

| Limit            | Value                                       |
| ---------------- | ------------------------------------------- |
| Events per batch | 1,000                                       |
| Event payload    | 256 KiB (send large content as an artifact) |
| Artifact         | 100 MiB                                     |

Payload strings, URLs, the environment summary and artifact metadata are pattern-redacted, and keys that name secrets are withheld. Redaction is best effort.

## `atlas run` (E02)

```bash
atlas run [-o <output>]... [--name <label>] [--root <path>] [--json] -- <command> [args...]
```

`atlas run` follows these steps:

1. It resolves the project from the deepest registered worktree containing the current directory, or from `--root`.
2. It creates the run with `waitForSnapshot`. When the tree has no matching snapshot, it is scanned **before** the command starts, because the command may write into the tree. If the tree changes during that scan, the run stays unbound with a `source-not-snapshotted` gap.
3. It spawns the command with an argv array and no shell, and mirrors its output to the terminal.
4. It records the output and exit:
   - stdout and stderr go to `command.stdout`/`command.stderr` events in chunks of up to 16 KiB, with an inline total of up to 10 MiB. Past that cap, a `capture.gap` `log-truncated` event is recorded.
   - The complete `stdout.log` and `stderr.log` are always uploaded as `log` artifacts.
   - `command.exit` records exit code, signal and duration. Ctrl-C is forwarded to the child, and the run is recorded as `cancelled`.
5. It handles declared outputs (files or directories, up to 200 files):
   - Files that exist are uploaded with `file.produced` events. Files not modified during the run are flagged with `producedDuringRun: false`, because a file existing does not prove this run produced it.
   - Declared outputs that do not exist are recorded as **missing** artifacts.
6. It records the process outcome: `succeeded` (exit 0), `failed`, or `cancelled`. Task outcome comes from assertions, so the two can differ.

The child receives `ATLAS_INGEST_URL`, `ATLAS_RUN_ID` and `ATLAS_RUN_TOKEN`, which hold a run-scoped token only.

## SDK for instrumented programs

`@atlas/adapters` exports `recorderFromEnv()`, which provides `step(name, fn)`, `assert(description, ok)`, `recordArtifact(path)` and `event(type, payload)`. Without the environment variables every call is a no-op.

Programs in other languages can use the HTTP protocol directly. `fixtures/research-demo/worker/generate-report.mjs` does this in about ten lines.

## Playwright capture helper (E03)

`BrowserCapture.attach(client, context, opts)` from `@atlas/adapters` instruments one explicitly chosen `BrowserContext`. Atlas never observes browsers it was not attached to.

- **`step(page, name, fn)`** emits `step.started`, runs the action, waits for the configured `waitPolicy`, takes a `post-action` screenshot and emits `step.completed`.
  - On an exception it takes a `failure-state` screenshot, emits `step.failed` with the redacted error, and rethrows.
  - `beforeEachStep` adds `pre-action` screenshots.
- **`screenshot(page, kind)`** captures real bytes with provenance:
  - Tab ID (`tab-1`, `tab-2`, … in order of appearance), redacted URL, title, viewport and kind.
  - The step event it belongs to, the wait policy, and any masked selectors (masking happens before the bytes are stored).
  - If the page is gone or the capture fails, the screenshot is recorded as a **missing** artifact with the reason, plus a `capture.gap` event.
- **Limits.** Screenshots are capped at `maxScreenshots`, 50 by default. Past that, one gap is recorded.
- **`finish()`** takes final screenshots of open tabs, emits per-tab `network.summary` and `console.summary` (bounded and redacted), and attaches the Playwright trace (`trace.zip`, open with `npx playwright show-trace`). If the caller already traces the context, as the Playwright test runner does, the trace is left to the caller and a gap records that.
- **Proof.** A post-action screenshot proves a captured state, not that asynchronous work finished. The wait policy is recorded with each screenshot for that reason.

`scripts/research-journey.ts` is the reference journey. `pnpm demo` runs the full local demo: scan, two `atlas run`s and the browser journey.

## Outputs & Audit UI and correlation (E04)

The **Outputs & Audit** root has two parts:

- **Overview.** Recent runs, filterable to failures, browser runs or commands. Process and task outcome are shown as separate labeled chips, with screenshot and artifact counts, missing counts, and whether the run executed on the current snapshot, an earlier one, or an un-snapshotted tree.
- **Run detail.** A header with outcome, source snapshot, capture gaps and linked components, plus five tabs:
  - Steps: hierarchy, tool calls and assertions.
  - Browser journey: a filmstrip in capture order. Missing screenshots are placeholders with their reason.
  - Code execution: command, working directory, exit, produced files, and stdout/stderr with stderr marked.
  - Artifacts: a gallery.
  - Audit trail: the append-only event table, gaps highlighted and missing parents reported.

**Previews** always come from the isolated origin:

| Content               | How it is shown                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Images                | `<img>`                                                                                                                           |
| Video                 | `<video>`                                                                                                                         |
| Text, JSON, CSV, logs | The preview server's escaped, script-free viewer page in an `<iframe sandbox="">`                                                 |
| HTML and SVG          | `<iframe sandbox="allow-scripts">`, never `allow-same-origin`. The server's sandbox CSP makes it an opaque origin with no network |
| Anything else         | An "open in isolated tab" link                                                                                                    |

An e2e test uploads HTML disguised as PNG that tries to write the parent DOM, read the UI token, use storage and cookies, and call the API. Every attempt fails.

**Correlation** (`packages/evidence/src/correlate.ts`) runs after a run finishes, and again when it binds to its snapshot. It uses entities of the run's own snapshot.

| Method               | Status    | When                                                                                                |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `explicit-entity-id` | supported | Events name entity IDs                                                                              |
| `command-mapping`    | supported | The run's argv names a source file of the snapshot. Outputs of that command link to the same module |
| `route-signature`    | inferred  | A screenshot URL path matches exactly one declared UI route                                         |

Anything else is shown as "unknown". Nothing is inferred from file names or timing.

**Cross-navigation.** Entity details list associated runs ("Outputs"). A run's linked components open the architecture **at the run's own snapshot**, with a visible "viewing an earlier snapshot, back to latest" badge, and select the entity so its evidence and source are one click away.

## Importing evidence (I03)

`atlas import <source> [--root <project>]` imports evidence the user approves.

**Imported runs are never linked to a snapshot.** They did not run against the current tree, so a capture gap `imported` says so. Each import has an external reference, and importing again reopens the same run:

- **Duplicates.** Events with the same stable producer ID dedupe.
- **Late events.** Late spans or events are appended.
- **Outcome.** The first outcome is kept.

### OpenTelemetry traces: a documented subset, not a collector

This mapping follows the OTLP/JSON encoding of `ExportTraceServiceRequest`, either a single document or one per line as the file exporter writes it.

| OTLP                                                                    | Atlas                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| trace                                                                   | one run (`adapter: otlp`, `externalRef: otlp:<traceId>`), start and end from its spans        |
| span                                                                    | `step.started` and `step.completed` (or `step.failed` on status ERROR), nested by parent span |
| span with `gen_ai.tool.name`, or `gen_ai.operation.name = execute_tool` | `tool.call.requested` and `tool.call.completed` (`ok: false` on ERROR)                        |
| attributes (string, int, double, bool, array, kvlist)                   | event payload, at most 64 per span, values at most 500 characters                             |
| span events, for example `exception`                                    | inside the end event's payload, at most 20                                                    |
| root status ERROR / OK / UNSET                                          | run failed / succeeded / unknown (OTLP has no run outcome)                                    |

Anything else produces a **diagnostic**, printed by the CLI. Warnings also become capture gaps on the run, so no evidence is dropped silently:

- protobuf, logs or metrics input (refused);
- invalid IDs (the span is skipped);
- base64 IDs (converted);
- a missing start time (skipped) or end time (imported as unfinished);
- bytes attributes (shown as `[bytes omitted]`);
- links (counted, not imported as relations);
- orphan spans, kept top-level until a later import supplies the parent;
- truncation;
- more than 20,000 spans.

Fixtures are in `fixtures/otlp/`, and the tests in `apps/cli/test/import.test.ts`.

### Atlas run bundle v1

A directory containing `atlas-run.json`:

```json
{
  "format": "atlas-run-bundle",
  "version": 1,
  "producer": "ci-agent",
  "run": {
    "key": "nightly-42",
    "name": "nightly evaluation",
    "status": "failed",
    "startedAt": "2026-10-26T01:00:00Z",
    "endedAt": "2026-10-26T01:00:09Z"
  },
  "events": [
    { "id": "root", "type": "step.started", "occurredAt": "…", "payload": { "name": "evaluate" } },
    {
      "id": "check",
      "type": "assertion.result",
      "occurredAt": "…",
      "parent": "root",
      "payload": { "outcome": "fail", "description": "score above 0.8" }
    }
  ],
  "artifacts": [{ "path": "out/report.json", "role": "report", "event": "root" }]
}
```

- **Events.** Local event IDs become stable producer event IDs, and a `parent` must name an earlier event of the bundle. Event types and assertion payloads are validated like any ingestion, and invalid events are rejected with a reason.
- **Artifact paths.** They must resolve inside the bundle, after symlinks. Traversal and escapes are refused and recorded as missing with a reason. Listed files that are absent are recorded as missing, and the limit is 100 MiB per file.
