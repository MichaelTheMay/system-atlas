# System design: whiteboard, copilot and generation (D02)

The **System design** root is a whiteboard over the semantic graph: boxes (client, API service,
worker, queue, datastore, cache, external API, library), flows and subsystems. D01 derives it from
detected code (see [views.md](views.md#system-design-lens-d01)). D02 lets you draw on it, adds a
copilot that suggests while you work, and adds an on-demand **Generate design** action run by an
agent of your choice.

Three rules hold throughout:

- **Who made it is always visible.** What a person draws or accepts is theirs. What an agent
  proposes is labeled `proposed` and `agent: <model>` until a person accepts it.
- **Nothing is written into analyzer facts.** Drawn elements live in their own table, grouping
  writes `subsystem` claims, and agent output is `inferred` claims. Entities and relations are
  never touched.
- **No model runs without your click.** The watcher, scans and the copilot's suggestions never
  call a model. Ask actions and Generate run only when you click them.

## Whiteboard

Drawn elements (boxes, flows, sticky notes, subsystems) are stored per project in
`design_elements`, so they survive every rescan. A box can be bound to code entities, or left
unbound, which means "planned, not in code yet" and is drawn dashed.

- **Grouping detected boxes** into a subsystem writes human `subsystem` claims through the claim
  validator, citing each entity's own evidence (`POST /projects/{id}/design/group`).
- **Hiding a detected box** records a `suppress` override. Code facts are never deleted.
- **Drift** between the board and the code is computed on every projection and always shown:
  - a drawn flow with no matching code relation ("drawn, not found in code");
  - a code flow between boxes that is not on the board (a faint ghost edge you can adopt);
  - a bound box whose entity disappeared (stale).

## Copilot

**Copilot** in the design toolbar opens a panel to the right of the canvas.

### Suggestions (no model, free)

Computed in the browser from the current projection, its drift and the snapshot's design claims
(`GET /snapshots/{id}/design/claims`). Each has **Apply** and **Dismiss**. Dismissals are kept per
project in the browser's local storage.

| Suggestion                                                       | Apply                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Two clients, services or workers share three or more neighbors   | Group them into a subsystem named after both (human claims)              |
| Boxes on the root that share an architectural layer are unplaced | Group them as that layer, for example "Messaging" or "Data"              |
| Other boxes on the root are not in any subsystem                 | Dismiss only: draw a subsystem or use Generate design                    |
| A code flow is not on the board                                  | Adopt it as a drawn flow                                                 |
| A drawn flow is not found in code                                | Remove the drawn flow                                                    |
| A bound box points at code that no longer exists                 | Unbind the missing entities                                              |
| Boxes have no responsibility claim                               | **Ask agent**: runs "Suggest responsibilities" (an explicit model click) |

Suggestions apply to the latest snapshot. When you view an earlier snapshot, Apply is disabled.

### Ask actions (configured runtime, on click only)

The panel shows the configured runtime. Pick boxes with the chips, or select a box, a subsystem or
a flow on the canvas, then click:

- **Propose a grouping** for two or more picked boxes. The agent proposes a subsystem through
  `atlas_propose_view`. Accept promotes it; Reject rejects its claims.
- **Name this subsystem** for a selected subsystem, the subsystem canvas you are on, or picked
  boxes. Accept groups the boxes under that name (human claims). Reject discards the answer.
- **Explain this flow** for a selected flow between two boxes. The answer always shows its
  citations, resolved to `file:line`. Accept keeps it as a sticky note on the canvas.
- **Suggest responsibilities** for picked boxes. The agent proposes cited `responsibility` claims.
  Accept re-proposes them as your claims through the validator; Reject rejects them (audited).

Every result is labeled `agent: <model>` with its citations, and links to its run.

## Generate design

**Generate design…** in the design toolbar (or `atlas design generate`) opens a confirm dialog.
Nothing runs until you click **Generate**. The dialog shows:

- the runtime and model;
- **what leaves this machine**: for Claude Code and the API key, the versioned design prompt and
  what the agent reads through the Atlas tools (entity and file names, relations, redacted
  excerpts of at most 400 characters); for the mock runtime, nothing;
- the **estimated tokens** against the **daily budget**: a rough upper estimate (about 900 input
  and 120 output tokens per box per level, plus a fixed prompt);
- **depth** (1 to 3 levels) and the **maximum subsystems per level** (2 to 12);
- whether to **keep or replace earlier proposals**. Replace rejects earlier agent `subsystem` and
  `responsibility` claims of the snapshot (audited). Accepted and hand-made work is never replaced.

The algorithm is top-down. Level 0 groups the boxes into subsystems, and each subsystem with more
than about six members is split again, down to the chosen depth. The agent works only through the
Atlas tools, so the citation validator rejects invented evidence. Boxes a person already grouped
are left alone.

While it runs, the dialog shows progress from `design.job` server-sent events and a **Cancel**
button. Each job is recorded as a run with adapter `design-agent`, bound to the snapshot it read,
with every tool call, the usage and the outcome. It appears in **Outputs & Audit**.

### Review

When the job finishes, the review sheet lists the proposed subsystems by level:

- **Accept** promotes one subsystem: the agent's claims are re-proposed as your claims, citing the
  same evidence, through the validator. Accepting a parent also accepts the subsystems nested in
  it. If the cited files changed, the promotion is refused with reasons.
- **Accept all** accepts every top-level proposal.
- **Reject** rejects the agent's `subsystem` claims at and below that path. The subsystem
  disappears from the board; the rejection stays in the audit trail.
- **Open run in Outputs & Audit** shows the job's run.

Nothing becomes accepted without a person.

## Runtimes

Choose one in **Settings → Design agent**. The panel shows whether each is available.

| Runtime                               | How it runs                                                                                                                                                                                                                                                | Cost                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Claude Code** (your Claude account) | The documented headless CLI: `claude -p <prompt> --output-format stream-json --mcp-config <temp config that starts atlas mcp> --allowedTools "mcp__atlas__*"`, in a temp directory. It uses your existing Claude Code login; Atlas never reads its tokens. | Counts against your Claude plan. Token usage is shown when the stream reports it.      |
| **Anthropic API key**                 | The official `@anthropic-ai/sdk` in a tool-use loop over the same Atlas tools, in the daemon. The model is selectable.                                                                                                                                     | Billed to your API account. Held to the daily token budget and recorded in the ledger. |
| **Mock**                              | Deterministic and local. Groups boxes by architectural layer, then by folder. For CI and demos.                                                                                                                                                            | Free. Nothing leaves the machine.                                                      |

Settings lists Claude Code first and marks it "default when available". Until you pick a runtime,
the stored default stays **Mock**, so no setup step can make Atlas call out.

**API key.** The key field is write-only: after you store a key, Settings shows only "key stored".
Atlas reads the key from the OS keychain (`secret-tool`, libsecret) when one is there, and
otherwise from `<data dir>/secrets/anthropic-api-key` (mode 0600), which is where the UI stores it.
The key is never returned by the API, shown in the UI or logged.

## Consent

The first use of Claude Code or the API key shows a one-time consent screen, in Settings, the
Generate dialog or the copilot. It lists what is sent and what is never sent or done. Recording
consent is its own click and never starts a job. Without recorded consent the daemon refuses the
job (`403 consent_required`) before creating a run or starting anything. You can withdraw consent
in Settings at any time.

## Privacy and what is never done

- Whole files, the repository and its history are never sent. Agents read names, relations and
  redacted excerpts of at most 400 characters through the Atlas tools.
- The agent gets no file, shell or web tools: only the Atlas tools.
- Atlas never schedules a model call. The watcher and scans never start a job, and copilot
  suggestions are computed without a model.
- Agent output never overwrites observed facts, accepted subsystems or hand-made elements.
- Atlas never reads Claude Code session files or tokens, and never depends on undocumented Claude
  internals.

## Costs

- **Mock:** free.
- **Claude Code:** counts against your Claude plan. It is not held to Atlas's API budget.
- **API key:** the M02 daily budget (default 200,000 tokens a day) applies. A job whose estimate
  would exceed the remaining budget is refused (`429 budget_exceeded`), and every job is recorded
  in the usage ledger.

## API

| Route                                                                    | Purpose                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GET/PUT /api/v1/settings/design-agent`                                  | Runtime, model, consent, API key (write-only), availability                |
| `GET /api/v1/projects/{id}/design/jobs/estimate`                         | Estimate, daily budget and what leaves the machine, for the confirm dialog |
| `POST/GET /api/v1/projects/{id}/design/jobs`                             | Start a job (manual) or list recent jobs                                   |
| `GET/DELETE /api/v1/projects/{id}/design/jobs/{jobId}`                   | One job, including a copilot answer (`output`); cancel                     |
| `GET /api/v1/snapshots/{id}/design/claims`                               | Subsystem and responsibility claims with ids, for review and the copilot   |
| `GET/POST/PATCH/DELETE /api/v1/projects/{id}/design/elements`            | Drawn elements, with optimistic revisions                                  |
| `POST /api/v1/projects/{id}/design/group`, `…/hide`                      | Group detected boxes (human claims); hide a detected box                   |
| `PUT /api/v1/views/{viewId}/override`, `POST /api/v1/claims/{id}/reject` | Promote a proposal; reject a claim                                         |

See `apps/daemon/openapi.yaml` for the shapes.
