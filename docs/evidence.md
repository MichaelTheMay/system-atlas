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
