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
