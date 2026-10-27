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

| Tool                                                                                      | What it returns or does                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `atlas_project_status`                                                                    | Project, latest snapshot, counts by kind, coverage and top gaps, open rename issues, watch state                                                       |
| `atlas_list_views`                                                                        | Canvas catalog of the latest snapshot (id, title, lens, parent, size, why). Filter by lens or title. Paginated, 50 per page by default, at most 200    |
| `atlas_get_view`                                                                          | One canvas: nodes, aggregated edges with relation kinds and status, breadcrumbs, child views. At most 80 nodes and 160 edges, flagged `truncated`      |
| `atlas_search`                                                                            | Entities by name prefix, optionally by kind. At most 50                                                                                                |
| `atlas_get_entity`                                                                        | Attributes, owners, children, relations (50 per page), claims, 5 evidence items, runs, last change                                                     |
| `atlas_get_evidence`                                                                      | Evidence for an entity (at most 20) or for up to 20 relations: file, lines, content hash, freshness, excerpt of at most 400 characters                 |
| `atlas_refresh`                                                                           | Rescans and returns the change summary; an unchanged tree is a no-op. `dryRun` only reports whether files changed since the snapshot                   |
| `atlas_list_runs`, `atlas_get_run`, `atlas_list_artifacts`, `atlas_get_artifact_metadata` | Runs with process and task outcome, linked components, events (50 per page, payloads trimmed) and artifact metadata. Artifact bytes are never returned |
| `atlas_start_run`, `atlas_record_event`, `atlas_record_artifact`, `atlas_finish_run`      | Record a run. See below                                                                                                                                |

Not exposed, by design (plan §12):

- filesystem access beyond the artifact rule below;
- SQL;
- command execution;
- anything outside the scoped project.

Proposals and annotations come with M02, with evidence and snapshot preconditions.

**Untrusted content.** Excerpts, file names, event payloads and artifact names are repository or run data. The server's instructions tell the agent to treat them as untrusted, never as instructions.

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
