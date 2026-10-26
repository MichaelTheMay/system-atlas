import { useEffect, useRef, useState } from 'react';
import {
  api,
  type CanvasSpecDto,
  type CoverageGap,
  type EntityDetailsDto,
  type EvidenceDto,
  type OverlayDto,
  type ProjectionDto,
  type RelationDetailsDto,
  type SnapshotSummary,
  type SourceDto,
} from '../api.ts';
import type { Location, Selection } from './CanvasView.tsx';

interface Props {
  token: string;
  snapshotId: string;
  rootPath?: string;
  projection: ProjectionDto | null;
  spec?: CanvasSpecDto;
  coverageCanvasId?: string;
  summary: SnapshotSummary | null;
  selection: Selection;
  overlay: OverlayDto | null;
  onEditOverlay(mutate: (o: OverlayDto) => OverlayDto): void;
  onNavigate(loc: Location): void;
}

export function Inspector(p: Props) {
  const [source, setSource] = useState<{ path: string; start?: number; end?: number } | null>(null);
  useEffect(() => {
    setSource(null);
  }, [p.selection, p.projection?.viewId]);
  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      {source ? (
        <SourcePanel
          token={p.token}
          snapshotId={p.snapshotId}
          rootPath={p.rootPath}
          {...source}
          onClose={() => setSource(null)}
        />
      ) : !p.selection ? (
        <CanvasInfo {...p} />
      ) : p.selection.type === 'edge' ? (
        <EdgeInfo
          token={p.token}
          snapshotId={p.snapshotId}
          relationIds={p.selection.relationIds}
          label={p.selection.label}
          onSource={setSource}
        />
      ) : p.selection.node.kind === 'entity' &&
        p.selection.node.entityId &&
        p.selection.node.lifecycle !== 'removed' ? (
        <EntityInfo {...p} entityId={p.selection.node.entityId} onSource={setSource} />
      ) : (
        <NodeInfo {...p} />
      )}
    </aside>
  );
}

function CanvasInfo({ projection, spec, summary, coverageCanvasId, onNavigate }: Props) {
  if (!projection)
    return (
      <p className="empty-note">
        Select an entity, relation or output to see its evidence, freshness and coverage.
      </p>
    );
  const c = summary?.changes;
  const changeLine = !c?.previousSnapshotId
    ? 'First snapshot of this worktree.'
    : Object.entries({ ...c.entities })
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ') || 'No entity changes since the previous scan.';
  return (
    <section aria-label="Canvas details" className="insp">
      <h3 className="insp-title">{projection.title}</h3>
      <p className="muted">
        {projection.lens} · {projection.stats.entities} entities · {projection.stats.relations}{' '}
        relations
        {projection.truncated && ' · truncated to 200 nodes'}
      </p>
      <h4 className="sub">Why this canvas?</h4>
      <p>{projection.relevanceReason}</p>
      {spec && (
        <p className="muted">Relevance {spec.relevanceScore.toFixed(2)} (policy relevance-v1)</p>
      )}
      <h4 className="sub">What is missing?</h4>
      <p>
        {spec?.coverageSummary.gapCount
          ? `${spec.coverageSummary.gapCount} coverage gap(s) fall in this scope.`
          : 'No coverage gaps recorded in this scope.'}
        {spec?.coverageSummary.staleCount
          ? ` ${spec.coverageSummary.staleCount} stale fact(s) kept from a previous scan.`
          : ''}
      </p>
      {coverageCanvasId && coverageCanvasId !== projection.canvasId && (
        <button
          type="button"
          className="link"
          onClick={() => onNavigate({ canvasId: coverageCanvasId })}
        >
          Open coverage & unknowns
        </button>
      )}
      <h4 className="sub">Last changed</h4>
      <p>{changeLine}</p>
      {projection.children.length > 0 && (
        <>
          <h4 className="sub">Child views</h4>
          <ul className="plain-list">
            {projection.children.map((ch) => (
              <li key={ch.canvasId}>
                <button
                  type="button"
                  className="link"
                  onClick={() => onNavigate({ canvasId: ch.canvasId })}
                >
                  {ch.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted hint">
        Double-click a node to open it. Drag to pin a position; pins survive rescans.
      </p>
    </section>
  );
}

function freshnessText(f: EvidenceDto['freshness']) {
  return f === 'current'
    ? 'current'
    : f === 'changed'
      ? 'file changed since'
      : f === 'deleted'
        ? 'file deleted'
        : 'unknown';
}

function EvidenceItem({
  ev,
  onSource,
  rootPath,
}: {
  ev: EvidenceDto;
  rootPath?: string;
  onSource(s: { path: string; start?: number; end?: number }): void;
}) {
  const loc = ev.repoRelativePath
    ? `${ev.repoRelativePath}${ev.startLine ? `:${ev.startLine}${ev.endLine && ev.endLine !== ev.startLine ? `-${ev.endLine}` : ''}` : ''}`
    : ev.sourceKind;
  return (
    <li className="evidence">
      <div className="ev-head">
        <code className="ev-loc">{loc}</code>
        <span className={`tag fresh-${ev.freshness}`}>{freshnessText(ev.freshness)}</span>
      </div>
      <div className="muted">
        {ev.sourceKind} · {ev.extractorId}@{ev.extractorVersion}
        {ev.redactionState !== 'none' && <span className="tag">redacted</span>}
      </div>
      {ev.excerpt && <pre className="excerpt">{ev.excerpt}</pre>}
      {ev.repoRelativePath && (
        <div className="ev-actions">
          <button
            type="button"
            className="link"
            onClick={() =>
              onSource({ path: ev.repoRelativePath!, start: ev.startLine, end: ev.endLine })
            }
          >
            View source
          </button>
          {rootPath && (
            <a
              className="link"
              href={`vscode://file/${rootPath}/${ev.repoRelativePath}:${ev.startLine ?? 1}`}
            >
              Open in editor
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function EntityInfo(
  p: Props & {
    entityId: string;
    onSource(s: { path: string; start?: number; end?: number }): void;
  },
) {
  const [d, setD] = useState<EntityDetailsDto | null>(null);
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState('');
  useEffect(() => {
    setD(null);
    api<EntityDetailsDto>(`/snapshots/${p.snapshotId}/entities/${p.entityId}`, p.token).then(
      setD,
      (e: Error) => setErr(e.message),
    );
  }, [p.snapshotId, p.entityId, p.token]);
  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  const e = d.entity;
  const pinned = p.overlay?.pinnedIds.includes(e.id);
  const notes = p.overlay?.annotations.filter((a) => a.targetId === e.id) ?? [];
  const groups = ['out', 'in'] as const;
  return (
    <section aria-label="Entity details" className="insp">
      <h3 className="insp-title">{e.displayName}</h3>
      <p className="muted">
        {e.kind} · from <code>{e.producer}</code>
        {e.lifecycle !== 'active' && (
          <span className={`tag tag-${e.lifecycle}`}>{e.lifecycle}</span>
        )}
      </p>
      <p className="canon">
        <code>{e.canonicalName}</code>
      </p>
      {d.owners.length > 0 && (
        <p className="muted">in {d.owners.map((o) => o.displayName).join(' › ')}</p>
      )}
      {d.children.length > 0 && (
        <p className="muted">owns {d.children.map((c) => `${c.n} ${c.kind}`).join(', ')}</p>
      )}
      {d.lastChange && (
        <p className="muted">
          last {d.lastChange.change} in snapshot {d.lastChange.snapshotId.slice(0, 13)}… (
          {new Date(d.lastChange.at).toLocaleString()})
        </p>
      )}

      <h4 className="sub">Evidence ({d.evidence.length})</h4>
      {d.evidence.length === 0 ? (
        <p className="muted">
          No direct evidence: this entity is derived (for example the system root).
        </p>
      ) : (
        <ul className="plain-list">
          {d.evidence.map((ev) => (
            <EvidenceItem key={ev.id} ev={ev} rootPath={p.rootPath} onSource={p.onSource} />
          ))}
        </ul>
      )}

      {groups.map((dir) => {
        const rs = d.relations.filter((r) => r.direction === dir);
        if (!rs.length) return null;
        return (
          <div key={dir}>
            <h4 className="sub">
              {dir === 'out' ? 'Outgoing' : 'Incoming'} relations ({rs.length})
            </h4>
            <ul className="plain-list rels">
              {rs.slice(0, 60).map((r) => (
                <li key={r.id}>
                  <span className="rel-kind">{r.kind}</span> {r.other.displayName}
                  <span className={`tag st-${r.status}`}>{r.status}</span>
                  <span className="tag">{r.confidence}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {d.claims.length > 0 && (
        <>
          <h4 className="sub">Claims</h4>
          <ul className="plain-list">
            {d.claims.map((c) => (
              <li key={c.id}>
                <strong>{c.predicate}</strong>: {String(c.value)}{' '}
                <span className="tag">{c.origin}</span>{' '}
                <span className={`tag st-${c.status}`}>{c.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="sub">Notes (yours, not facts)</h4>
      {notes.map((n) => (
        <p key={n.id} className="note">
          {n.text}
        </p>
      ))}
      <form
        className="note-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          const text = note.trim();
          if (!text) return;
          const id = `ann_${crypto.randomUUID().replaceAll('-', '')}`;
          p.onEditOverlay((o) => ({
            ...o,
            annotations: [
              ...o.annotations,
              { id, targetId: e.id, text, createdAt: new Date().toISOString() },
            ],
          }));
          setNote('');
        }}
      >
        <label className="sr-only" htmlFor="note-input">
          Add a note
        </label>
        <input
          id="note-input"
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          placeholder="Add a note to this view"
          maxLength={2000}
        />
        <button type="submit">Add</button>
      </form>
      {pinned && (
        <button
          type="button"
          className="link"
          onClick={() =>
            p.onEditOverlay((o) => {
              const positions = { ...o.entityPositions };
              delete positions[e.id];
              return {
                ...o,
                entityPositions: positions,
                pinnedIds: o.pinnedIds.filter((x) => x !== e.id),
              };
            })
          }
        >
          Unpin position
        </button>
      )}
    </section>
  );
}

function EdgeInfo({
  token,
  snapshotId,
  relationIds,
  label,
  onSource,
}: {
  token: string;
  snapshotId: string;
  relationIds: string[];
  label: string;
  onSource(s: { path: string; start?: number; end?: number }): void;
}) {
  const [rels, setRels] = useState<RelationDetailsDto[] | null>(null);
  useEffect(() => {
    setRels(null);
    api<{ relations: RelationDetailsDto[] }>(
      `/snapshots/${snapshotId}/relations?ids=${relationIds.join(',')}`,
      token,
    ).then((r) => setRels(r.relations));
  }, [token, snapshotId, relationIds]);
  return (
    <section aria-label="Edge details" className="insp">
      <h3 className="insp-title">Why this edge?</h3>
      <p className="muted">{label}</p>
      {!rels ? (
        <p className="muted">Loading…</p>
      ) : (
        rels.map((r) => (
          <div key={r.id} className="rel-block">
            <p>
              <strong>{r.from.displayName}</strong> <span className="rel-kind">{r.kind}</span>{' '}
              <strong>{r.to.displayName}</strong>
            </p>
            <p className="muted">
              <span className={`tag st-${r.status}`}>{r.status}</span>{' '}
              <span className="tag">{r.confidence}</span> from <code>{r.producer}</code>
              {Object.keys(r.qualifiers).length > 0 &&
                ` · ${Object.entries(r.qualifiers)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')}`}
            </p>
            {r.status !== 'supported' && (
              <p className="muted">
                Not a verified fact:{' '}
                {r.status === 'inferred'
                  ? 'derived by a heuristic rule'
                  : 'kept from an earlier scan'}
                .
              </p>
            )}
            <ul className="plain-list">
              {r.evidence.map((ev) => (
                <EvidenceItem key={ev.id} ev={ev} onSource={onSource} />
              ))}
            </ul>
          </div>
        ))
      )}
      {relationIds.length >= 50 && <p className="muted">Showing the first 50 relations.</p>}
    </section>
  );
}

function NodeInfo({ selection, summary, onNavigate, projection }: Props) {
  if (selection?.type !== 'node') return null;
  const n = selection.node;
  const gaps: CoverageGap[] =
    n.kind === 'gap' && summary
      ? summary.coverage.gaps.filter((g) => `gap:${g.kind}` === n.id || n.id === 'gap:summary')
      : [];
  return (
    <section aria-label="Node details" className="insp">
      <h3 className="insp-title">{n.label}</h3>
      <p className="muted">
        {n.kind}
        {n.sublabel ? ` · ${n.sublabel}` : ''}
      </p>
      {n.lifecycle === 'removed' && (
        <p>Removed since the previous snapshot. This is a tombstone kept for change review.</p>
      )}
      {n.kind === 'port' && <p>Relations leave this view toward {n.label}.</p>}
      {n.counts && (
        <p className="muted">
          {Object.entries(n.counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')}
        </p>
      )}
      {n.focus !== undefined && projection && (
        <button
          type="button"
          className="action-sm"
          onClick={() => onNavigate({ canvasId: projection.canvasId, focus: n.focus })}
        >
          Expand {n.label}
        </button>
      )}
      {n.openCanvasId && (
        <button
          type="button"
          className="action-sm"
          onClick={() => onNavigate({ canvasId: n.openCanvasId! })}
        >
          Open {n.label}
        </button>
      )}
      {gaps.length > 0 && (
        <ul className="gaps">
          {gaps.slice(0, 100).map((g, i) => (
            <li key={i}>
              {g.path && <code>{g.path}</code>}
              <span className="gap-detail">{g.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SourcePanel({
  token,
  snapshotId,
  path,
  start,
  end,
  rootPath,
  onClose,
}: {
  token: string;
  snapshotId: string;
  path: string;
  start?: number;
  end?: number;
  rootPath?: string;
  onClose(): void;
}) {
  const [src, setSrc] = useState<SourceDto | null>(null);
  const [err, setErr] = useState<string>();
  const hl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api<SourceDto>(`/snapshots/${snapshotId}/source?path=${encodeURIComponent(path)}`, token).then(
      setSrc,
      (e: Error) => setErr(e.message),
    );
  }, [token, snapshotId, path]);
  // block body: scroll methods may return a Promise in newer browsers, which React would treat as a cleanup
  useEffect(() => {
    hl.current?.scrollIntoView({ block: 'center' });
  }, [src]);
  return (
    <section aria-label="Source" className="insp source">
      <div className="source-head">
        <code>{path}</code>
        <button type="button" className="link" onClick={onClose}>
          Back to details
        </button>
      </div>
      {rootPath && (
        <a className="link" href={`vscode://file/${rootPath}/${path}:${start ?? 1}`}>
          Open in editor
        </a>
      )}
      {err && <p className="error">{err}</p>}
      {src?.state === 'changed' && (
        <p className="warn">
          This file changed after the snapshot. The evidence refers to the earlier content, so it is
          not shown here; rescan to refresh.
        </p>
      )}
      {src?.state === 'deleted' && <p className="warn">This file no longer exists on disk.</p>}
      {src?.text != null && (
        <div className="code" role="region" aria-label={`Source of ${path}`}>
          {src.text.split('\n').map((line, i) => {
            const n = i + 1;
            const on = start !== undefined && n >= start && n <= (end ?? start);
            return (
              <div
                key={n}
                ref={on && n === start ? hl : undefined}
                className={on ? 'line hl' : 'line'}
              >
                <span className="ln">{n}</span>
                <span className="lc">{line || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
