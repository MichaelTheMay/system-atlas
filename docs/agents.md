# Agents: MCP server and event SDK (I01)

Atlas gives coding agents two ways in:

- **Read the map** through MCP tools.
- **Record what they did** as evidence: steps, tool calls, assertions and artifacts. This works through the same MCP server or through the SDK.

Atlas works without any agent connected. Nothing here calls a model.

## Connect an MCP client

`atlas mcp [path]` serves the tools over stdio, scoped to the project at `path` (default: the current directory). It starts the local daemon if needed. The agent can read and write only that project.

Example for Claude Code, run in the repository you want mapped:

```bash
claude mcp add atlas -- /path/to/system-atlas/bin/atlas mcp "$PWD"
```

The generic configuration for MCP clients that take a JSON server list:

```json
{
  "mcpServers": {
    "atlas": { "command": "/path/to/system-atlas/bin/atlas", "args": ["mcp", "/path/to/repo"] }
  }
}
```

## Tools

| Tool                                                                                      | What it returns or does                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas_project_status`                                                                    | Project, latest snapshot, counts by kind, coverage and top gaps, open rename issues, watch state                                                                                      |
| `atlas_list_views`                                                                        | Canvas catalog of the latest snapshot (id, title, workspace, lens, provenance, parent, size, why). Filter by workspace, lens or title. Paginated, 50 per page by default, at most 200 |
| `atlas_get_view`                                                                          | One canvas: nodes, aggregated edges with relation kinds and status, breadcrumbs, child views. At most 80 nodes and 160 edges, flagged `truncated`                                     |
| `atlas_search`                                                                            | Entities by name prefix, optionally by kind. At most 50                                                                                                                               |
| `atlas_get_entity`                                                                        | Attributes, owners, children, relations (50 per page), claims, 5 evidence items, runs, last change                                                                                    |
| `atlas_get_evidence`                                                                      | Evidence for an entity (at most 20) or for up to 20 relations: file, lines, content hash, freshness, excerpt of at most 400 characters                                                |
| `atlas_refresh`                                                                           | Rescans and returns the change summary; an unchanged tree is a no-op. `dryRun` only reports whether files changed since the snapshot                                                  |
| `atlas_list_runs`, `atlas_get_run`, `atlas_list_artifacts`, `atlas_get_artifact_metadata` | Runs with process and task outcome, linked components, events (50 per page, payloads trimmed) and artifact metadata. Artifact bytes are never returned                                |
| `atlas_start_run`, `atlas_record_event`, `atlas_record_artifact`, `atlas_finish_run`      | Record a run. See below                                                                                                                                                               |
| `atlas_propose_claims`                                                                    | Propose cited, labeled claims about entities against a snapshot precondition. See below                                                                                               |
| `atlas_propose_view`                                                                      | Propose system-design subsystems (named groups of entities, nested with `/`). Stored as cited `subsystem` claims. See below                                                           |
| `atlas_annotate`                                                                          | A short note on an entity, shown on its canvas and labeled as written by an agent                                                                                                     |

Not exposed, by design (plan §12):

- filesystem access beyond the artifact rule below;
- SQL;
- command execution;
- anything outside the scoped project.

Proposals can only add labeled claims. They never change analyzer facts or relations.

**Untrusted content.** Excerpts, file names, event payloads and artifact names are repository or run data. The server's instructions tell the agent to treat them as untrusted, never as instructions.

## Proposing claims (M02a)

`atlas_propose_claims { snapshotId, claims: [{ subjectId, predicate, value, citations, rationale? }] }`.

**Predicates** form a closed set. Anything else is rejected, which is how proposals are kept from overwriting observed facts:

| Predicate        | Value                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `summary`        | Text up to 600 characters                                                                              |
| `responsibility` | Text up to 300 characters                                                                              |
| `subsystem`      | A name, up to 80 characters                                                                            |
| `role`           | One of `entrypoint`, `api`, `worker`, `library`, `storage`, `ui`, `test`, `config`, `tooling`, `other` |
| `concern`        | Text up to 400 characters                                                                              |
| `depends-on`     | `{ entityId, reason }`. Stays a claim: it never becomes a relation                                     |

**Citations** are required for model claims, between 1 and 10 each. Every citation must be one of these:

- `{ evidenceId }` for existing evidence of this project. If it names a file, its hash must equal that file's hash in the snapshot. If it names no file, it must come from a run of this project.
- `{ path, startLine, endLine, quote? }` for a file range of the snapshot, at most 200 lines. The file's bytes on disk must still match the snapshot. The lines must exist, and the quote, compared with whitespace normalized, must appear in them.

**Validation and storage** happen in the daemon, the single writer:

- Invalid items are rejected with reasons and nothing is written for them. Valid items in the same call are stored.
- File citations become evidence pinned to the file's hash, so editing the file turns the claim stale at the next snapshot.
- Model claims are stored as `inferred`, never `supported`. People citing evidence through `POST /proposals/claims` with `origin: human` get `supported`.
- If a newer snapshot was published, the call fails with `stale_precondition`: re-read and retry.

**Model metadata** records only what the client reported: its initialize name and version, or a `model` argument. No hidden reasoning is requested or stored.

**Audit.** Every call is kept with accepted and rejected items and their reasons (`GET /projects/:id/proposals`). In the UI Inspector, claims show origin, reported model, status and citation count, and a person can **Reject** one. The rejection is audited and survives later snapshots.

## Built-in enrichment (M02b)

Atlas can also ask a configured model provider for claims. This is **off by default** (`provider: none`), and Atlas ships **no network provider**. The only implementations are deterministic mocks for tests and demos:

- `mock` proposes a role and a summary;
- `mock-adversarial` also proposes claims with invented citations.

A real provider would send repository excerpts to a third party and cost money, so one is added only with the user's consent.

```bash
atlas enrich --provider mock --max-tokens-per-day 50000   # configure
atlas enrich --entity ent_…                                # propose claims for entities
atlas enrich                                               # provider, budget and today's usage
```

The UI Inspector shows **Propose claims (provider)** when a provider is configured.

- **Explicit only.** Requests come from the CLI, the API (`POST /worktrees/:id/enrich`) or the Inspector. Scans and watcher churn never call a model, and a test asserts zero provider calls while files change under watch.
- **Redacted, bounded bundle.**
  - The bundle holds the entity, its owners, up to 30 relations, and up to 4 evidence excerpts of at most 60 lines and 1,500 characters each.
  - Excerpts are read hash-verified, and redacted before the provider sees them. A test puts an `sk-…` key in a file and checks that it never reaches the provider.
- **Cache.** Results are keyed by the SHA-256 of the bundle, the output schema version and the provider, model and prompt version. An identical request makes no provider call, and claims a model already stated are not duplicated.
- **Budget and ledger.**
  - Each request is ledgered with estimated and provider-reported tokens kept apart.
  - A daily budget counts the larger of the two per request and stops a request before it is sent (`skipped-budget`).
  - A newer request for the same entity cancels the older one (`cancelled`).
  - `GET /projects/:id/enrichment` shows today's usage.
- **Same validation.** Provider output goes through the same validator as agent proposals, so the invented citations from `mock-adversarial` are rejected with reasons. Model metadata records the provider, model, prompt version and input digest.

## Recording a run over MCP

1. `atlas_start_run { name }` creates a run. Like `atlas run`, it is bound to the snapshot of the current tree, scanning it first if needed. It returns a `runId`. The run's ingest token stays inside the MCP server process.
2. `atlas_record_event { runId, type, payload?, parentEventId?, entityIds? }`:
   - Event types are the schema's (`step.started`, `tool.call.completed`, `assertion.result`, …).
   - `entityIds` link the event to map entities. This is explicit correlation, shown as "supported".
   - `assertion.result` needs `{ outcome: "pass" | "fail" | "unknown", description }`. Ingestion rejects anything else, rather than storing an assertion it cannot count.
3. `atlas_record_artifact { runId, path | text }`:
   - `path` is relative to the project root and must resolve, after symlinks, to a regular file inside it.
   - `text` attaches short text, up to 1 MB.
4. `atlas_finish_run { runId, status }`. Process status and task outcome stay separate: a failed assertion marks the task failed even when the run succeeded. Ingestion errors are reported back and recorded as capture gaps.

Only runs started in the same MCP session can be written.

## Generic event SDK (any Node program)

```ts
import { localDaemon, recorderFor, startRun } from '@atlas/adapters';

const { client } = await startRun({
  daemon: localDaemon(),
  rootPath: process.cwd(),
  adapter: 'my-agent',
});
const atlas = recorderFor(client);
await atlas.step('plan', () => plan()); // step.started / completed / failed, timed
await atlas.assert('tests pass', ok); // counts toward the task outcome
await atlas.recordArtifact('out/report.json');
await client.finish('succeeded');
```

- `localDaemon()` reads the daemon's discovery record, which is owner-only (0600).
- Programs started by `atlas run` use `recorderFromEnv()` instead, with a run-scoped token from the environment and never the daemon token.
- Other languages can use the HTTP ingestion protocol directly. See [evidence.md](evidence.md) and `apps/daemon/openapi.yaml`.

Duplicate events, identified by producer and producer event ID, are deduplicated. Late events and events with missing parents are kept and flagged.

## Proposing subsystems (D01)

`atlas_propose_view { snapshotId, subsystems: [{ name, members: [{ entityId, citations }], responsibility? }], model? }`.

- **Names** are up to 80 characters. Nest with `/`, for example `Backend/Auth`, up to 3 levels.
- **Limits:** 1 to 10 subsystems per call, each with 1 to 25 members.
- **Claims:** each member becomes a `subsystem` claim whose value is the name. When `responsibility` is given (up to 300 characters), the member also gets a `responsibility` claim with the same citations.
- **Batching:** the claims are validated exactly like `atlas_propose_claims`. A call with more than 25 claims is split into several proposals.
- **Result:** for each subsystem, the accepted member ids, the rejected members with their reasons, and the proposal ids.
- **Model metadata** is recorded the same way as for `atlas_propose_claims`: as reported by the client.

The claims are labeled `inferred`. The design workspace shows them as `proposed` boxes, without a rescan.

**Promotion.** Only a person can turn a proposal into an accepted subsystem, with `PUT /api/v1/views/{viewId}/override { action: 'promote', … }`. This re-proposes the matching model claims as human claims citing the same evidence, and the validator checks them again. If the cited files changed since the claims were made, the promotion is refused with reasons.
