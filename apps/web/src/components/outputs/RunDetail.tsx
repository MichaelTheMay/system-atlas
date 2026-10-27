import { useMemo, useState } from 'react';
import type { ArtifactDto, EventDto, RunDetailDto } from '../../api.ts';
import { formatBytes, Preview } from './Preview.tsx';
import { StatusChip } from './RunList.tsx';

type Tab = 'steps' | 'browser' | 'code' | 'artifacts' | 'audit';

interface Props {
  token: string;
  detail: RunDetailDto;
  latestSnapshotId?: string;
  onOpenEntity(snapshotId: string, entityId: string): void;
}

export function RunDetail({ token, detail, latestSnapshotId, onOpenEntity }: Props) {
  const { run, outcome } = detail;
  const shots = useMemo(() => orderedScreenshots(detail), [detail]);
  const isProcess = run.adapter === 'process';
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'steps', label: 'Steps', show: true },
    { id: 'browser', label: `Browser journey (${shots.length})`, show: shots.length > 0 },
    { id: 'code', label: 'Code execution', show: isProcess },
    { id: 'artifacts', label: `Artifacts (${detail.artifacts.length})`, show: true },
    { id: 'audit', label: `Audit trail (${detail.events.length})`, show: true },
  ];
  const [tab, setTab] = useState<Tab>(shots.length ? 'browser' : isProcess ? 'code' : 'steps');
  const duration = run.endAt
    ? Math.round((Date.parse(run.endAt) - Date.parse(run.startAt)) / 100) / 10
    : undefined;

  return (
    <section className="run-detail" aria-label="Run detail">
      <header className="rd-head">
        <h2 className="rd-title">{run.commandSummary ?? run.id}</h2>
        <div className="rc-chips">
          <StatusChip label="process" value={outcome.process} />
          {run.exitCode !== undefined && <span className="chip">exit {run.exitCode}</span>}
          {run.signal && <span className="chip">signal {run.signal}</span>}
          <StatusChip label="task" value={outcome.task} />
          <span className="chip">
            assertions {outcome.assertions.pass}✓ {outcome.assertions.fail}✗{' '}
            {outcome.assertions.unknown}?
          </span>
          {duration !== undefined && <span className="chip">{duration}s</span>}
        </div>
        <p className="muted">
          {run.adapter} · started {new Date(run.startAt).toLocaleString()} ·{' '}
          {run.snapshotId ? (
            <span
              className={`snap-badge ${run.snapshotId === latestSnapshotId ? '' : 'historical'}`}
              title={run.snapshotId}
            >
              source snapshot {run.snapshotId.slice(5, 13)}
              {run.snapshotId === latestSnapshotId ? ' (current)' : ' (earlier snapshot)'}
            </span>
          ) : (
            <span className="snap-badge unbound">source not snapshotted</span>
          )}
        </p>
        {run.captureGaps.length > 0 && (
          <ul className="gaps-inline" aria-label="Capture gaps">
            {run.captureGaps.map((g, i) => (
              <li key={i}>
                <strong>{g.kind}</strong> {g.detail}
              </li>
            ))}
          </ul>
        )}
        <div className="links" aria-label="Linked components">
          <span className="muted">Linked components:</span>{' '}
          {detail.links.length === 0 ? (
            <span className="muted">unknown (no correlation evidence; nothing is guessed)</span>
          ) : (
            uniqueLinks(detail).map((l) => (
              <button
                key={l.entityId}
                type="button"
                className="link-chip"
                disabled={!run.snapshotId}
                onClick={() => run.snapshotId && onOpenEntity(run.snapshotId, l.entityId)}
                title={`${l.method} · ${l.status}`}
              >
                {l.entity?.displayName ?? l.entityId.slice(0, 12)}{' '}
                <span className="muted">
                  ({l.method}, {l.status})
                </span>
              </button>
            ))
          )}
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Run views">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === 'steps' && <Steps detail={detail} />}
        {tab === 'browser' && <Filmstrip token={token} shots={shots} events={detail.events} />}
        {tab === 'code' && <Code detail={detail} />}
        {tab === 'artifacts' && <Gallery token={token} detail={detail} />}
        {tab === 'audit' && <Audit detail={detail} />}
      </div>
    </section>
  );
}

function uniqueLinks(d: RunDetailDto) {
  const seen = new Map<string, RunDetailDto['links'][number]>();
  for (const l of d.links)
    if (!seen.has(l.entityId) || l.status === 'supported') seen.set(l.entityId, l);
  return [...seen.values()];
}

function orderedScreenshots(d: RunDetailDto): ArtifactDto[] {
  const order = new Map(d.events.map((e, i) => [e.id, i]));
  return d.artifacts
    .filter((a) => a.role === 'screenshot')
    .sort(
      (a, b) =>
        (order.get(a.eventId ?? '') ?? 1e9) - (order.get(b.eventId ?? '') ?? 1e9) ||
        a.logicalName.localeCompare(b.logicalName),
    );
}

function Steps({ detail }: { detail: RunDetailDto }) {
  const byParent = new Map<string, EventDto[]>();
  for (const e of detail.events)
    if (e.parentEventId)
      (
        byParent.get(e.parentEventId) ?? byParent.set(e.parentEventId, []).get(e.parentEventId)!
      ).push(e);
  const isStep = (e: EventDto) =>
    e.type === 'step.started' || e.type === 'tool.call.requested' || e.type === 'run.started';
  const steps = detail.events.filter(isStep);
  const stepIds = new Set(steps.map((s) => s.id));
  // a step whose parent is another step is drawn inside it (spans, nested SDK steps)
  const top = steps.filter((s) => !s.parentEventId || !stepIds.has(s.parentEventId));

  const stateOf = (s: EventDto): 'failed' | 'done' | 'unknown' => {
    const kids = byParent.get(s.id) ?? [];
    if (kids.some((k) => k.type === 'step.failed')) return 'failed';
    const toolEnd =
      s.type === 'tool.call.requested'
        ? (kids.find((k) => k.type === 'tool.call.completed') ??
          detail.events.find(
            (e) =>
              e.type === 'tool.call.completed' &&
              !e.parentEventId &&
              e.payload.tool === s.payload.tool &&
              (e.sequence ?? 0) > (s.sequence ?? 0),
          ))
        : undefined;
    if (toolEnd) return toolEnd.payload.ok === false ? 'failed' : 'done';
    if (kids.some((k) => k.type === 'step.completed' || k.type === 'command.exit')) return 'done';
    return s.type === 'run.started' ? 'done' : 'unknown';
  };
  const errorOf = (s: EventDto) => {
    const kids = byParent.get(s.id) ?? [];
    const end = kids.find(
      (k) =>
        k.type === 'step.failed' || (k.type === 'tool.call.completed' && k.payload.ok === false),
    );
    return end ? String(end.payload.error ?? '') : '';
  };

  const render = (list: EventDto[], depth: number) => (
    <ol className={depth ? 'step-list nested' : 'step-list'}>
      {list.map((s) => {
        const state = stateOf(s);
        const error = state === 'failed' ? errorOf(s) : '';
        const children = (byParent.get(s.id) ?? []).filter(isStep);
        return (
          <li key={s.id} className={`step st-${state}`}>
            <span className="step-mark" aria-hidden>
              {state === 'failed' ? '✗' : state === 'done' ? '✓' : '…'}
            </span>
            <span className="step-name">
              {s.type === 'tool.call.requested'
                ? `tool: ${String(s.payload.tool)}`
                : s.type === 'run.started'
                  ? 'run started'
                  : String(s.payload.name)}
            </span>
            <span className="muted"> {state === 'unknown' ? 'no completion recorded' : state}</span>
            {error && <pre className="excerpt">{error}</pre>}
            {children.length > 0 && render(children, depth + 1)}
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="steps">
      {steps.length === 0 && (
        <p className="empty-note">No step events were recorded for this run.</p>
      )}
      {render(top, 0)}
      {detail.assertions.length > 0 && (
        <>
          <h3 className="sub">Assertions</h3>
          <ul className="plain-list">
            {detail.assertions.map((a) => (
              <li key={a.id} className={`assert as-${a.outcome}`}>
                <span
                  className={`chip chip-${a.outcome === 'pass' ? 'succeeded' : a.outcome === 'fail' ? 'failed' : 'unknown'}`}
                >
                  {a.outcome}
                </span>{' '}
                {a.description}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Filmstrip({
  token,
  shots,
  events,
}: {
  token: string;
  shots: ArtifactDto[];
  events: EventDto[];
}) {
  const [open, setOpen] = useState<ArtifactDto | null>(null);
  const stepName = (a: ArtifactDto) => {
    const stepId = a.metadata.stepEventId as string | undefined;
    const ev = events.find((e) => e.id === stepId);
    return ev ? String(ev.payload.name ?? '') : String(a.metadata.kind ?? '');
  };
  return (
    <div className="filmstrip-wrap">
      <ol className="filmstrip" aria-label="Screenshots in capture order">
        {shots.map((s, i) => (
          <li
            key={s.id}
            className={`frame-card kind-${String(s.metadata.kind)} ${s.bytesState !== 'available' ? 'is-missing' : ''}`}
          >
            <button
              type="button"
              className="frame-btn"
              onClick={() => setOpen(s)}
              aria-label={`Screenshot ${i + 1}: ${String(s.metadata.kind)} ${stepName(s)}`}
            >
              <Preview token={token} artifact={s} size="thumb" />
            </button>
            <div className="frame-meta">
              <span className="frame-n">{i + 1}</span>{' '}
              <span className={`tag kind-tag k-${String(s.metadata.kind)}`}>
                {String(s.metadata.kind)}
              </span>{' '}
              {stepName(s)}
              <div className="muted frame-url">
                {String(s.metadata.tabId ?? '')} · {String(s.metadata.url ?? '')}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {open && (
        <div className="lightbox" role="dialog" aria-label={`Screenshot ${open.logicalName}`}>
          <div className="lb-head">
            <strong>{open.logicalName}</strong>
            <span className="muted">
              {String(open.metadata.kind)} · {String(open.metadata.url ?? '')} · viewport{' '}
              {JSON.stringify(open.metadata.viewport ?? null)} · sha256 {open.sha256.slice(0, 12)}
            </span>
            <button type="button" className="icon-btn" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <Preview token={token} artifact={open} />
          <p className="muted">
            A screenshot shows a captured visual state; it does not by itself prove the workflow
            succeeded.
          </p>
        </div>
      )}
    </div>
  );
}

function Code({ detail }: { detail: RunDetailDto }) {
  const started = detail.events.find((e) => e.type === 'run.started');
  const exit = detail.events.find((e) => e.type === 'command.exit');
  const out = detail.events.filter(
    (e) => e.type === 'command.stdout' || e.type === 'command.stderr',
  );
  const truncated = detail.events.some(
    (e) => e.type === 'capture.gap' && e.payload.kind === 'log-truncated',
  );
  const produced = detail.events.filter((e) => e.type === 'file.produced');
  return (
    <div className="code-exec">
      <dl className="facts">
        <dt>Command</dt>
        <dd>
          <code>
            {(started?.payload.argv as string[] | undefined)?.join(' ') ??
              detail.run.commandSummary}
          </code>
        </dd>
        <dt>Working dir</dt>
        <dd>{String(detail.run.environmentSummary.cwd ?? '.')} (relative to the project root)</dd>
        <dt>Exit</dt>
        <dd>
          {exit
            ? `code ${String(exit.payload.exitCode)}${exit.payload.signal ? `, signal ${String(exit.payload.signal)}` : ''} after ${String(exit.payload.durationMs)} ms`
            : 'no exit recorded'}
        </dd>
        <dt>Produced files</dt>
        <dd>
          {produced.length
            ? produced
                .map(
                  (p) =>
                    String(p.payload.path) +
                    (p.payload.producedDuringRun === false
                      ? ' (not modified during this run)'
                      : ''),
                )
                .join(', ')
            : 'none declared'}
        </dd>
      </dl>
      <h3 className="sub">Output</h3>
      {truncated && (
        <p className="warn">
          Inline output was truncated; the full logs are attached as artifacts.
        </p>
      )}
      <pre className="log" aria-label="Command output">
        {out.length === 0 ? (
          <span className="muted">(no output)</span>
        ) : (
          out.map((e) => (
            <span key={e.id} className={e.type === 'command.stderr' ? 'stderr' : 'stdout'}>
              {String(e.payload.text)}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}

function Gallery({ token, detail }: { token: string; detail: RunDetailDto }) {
  const linked = new Map(detail.links.map((l) => [l.eventOrArtifactId, l]));
  return (
    <ul className="gallery" aria-label="Artifacts">
      {detail.artifacts.map((a) => {
        const l = linked.get(a.id);
        return (
          <li key={a.id} className={`art-card ${a.bytesState !== 'available' ? 'is-missing' : ''}`}>
            <Preview token={token} artifact={a} size="thumb" />
            <div className="art-meta">
              <strong>{a.logicalName}</strong>
              <span className="muted">
                {a.role} · {a.mediaType} · {formatBytes(a.byteLength)}
                {a.metadata.mediaTypeMismatch
                  ? ` · declared ${String(a.metadata.declaredMediaType)}`
                  : ''}
              </span>
              <span className="muted">
                {a.bytesState === 'available' ? `sha256 ${a.sha256.slice(0, 12)}` : a.bytesState}
                {l
                  ? ` · produced by ${l.entity?.displayName ?? 'linked component'} (${l.method})`
                  : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Audit({ detail }: { detail: RunDetailDto }) {
  return (
    <div className="audit">
      {detail.missingParents.length > 0 && (
        <p className="warn">
          {detail.missingParents.length} event(s) reference parents that have not arrived (late or
          lost evidence).
        </p>
      )}
      <table className="audit-table">
        <caption className="sr-only">Append-only event timeline</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Type</th>
            <th scope="col">Producer</th>
            <th scope="col">Occurred</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {detail.events.map((e) => (
            <tr
              key={e.id}
              className={e.type === 'capture.gap' || e.type === 'step.failed' ? 'row-warn' : ''}
            >
              <td>{e.sequence ?? '–'}</td>
              <td>
                <code>{e.type}</code>
              </td>
              <td>{e.producerId}</td>
              <td>
                <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleTimeString()}</time>
              </td>
              <td className="audit-detail">
                {summarize(e)}
                {e.payload._redaction ? <span className="tag">redacted</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(e: EventDto): string {
  const p = e.payload;
  switch (e.type) {
    case 'command.stdout':
    case 'command.stderr':
      return `${String(p.text).length} chars at offset ${String(p.offset)}`;
    case 'screenshot.captured':
      return `${String(p.kind)} ${String(p.tabId)} ${String(p.url)}`;
    case 'step.started':
    case 'step.completed':
    case 'step.failed':
      return `${String(p.name)}${p.error ? ` — ${String(p.error).split('\n')[0]}` : ''}`;
    case 'assertion.result':
      return `${String(p.outcome)}: ${String(p.description)}`;
    case 'capture.gap':
      return `${String(p.kind)}: ${String(p.detail ?? '')}`;
    default:
      return JSON.stringify(p).slice(0, 160);
  }
}
