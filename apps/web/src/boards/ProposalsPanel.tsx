import { useEffect, useRef, useState } from 'react';
import { componentTypeInfo, DOC_SECTION_LABEL, type DesignBoard } from '@atlas/schema';
import { reviewBoard } from './useBoardJobs.ts';
import './board-agent.css';

interface Row {
  id: string;
  kind: 'component' | 'connection' | 'scenario' | 'doc-item';
  title: string;
  detail: string;
  model: string;
}

/** Proposed registry items of a board, newest kinds first (components, connections, …). */
export function proposedRows(board: DesignBoard): Row[] {
  const d = board.document;
  const name = (id: string) => d.components[id]?.label ?? id;
  const by = (o: { name?: string; author: string }) => o.name ?? o.author;
  return [
    ...Object.values(d.components)
      .filter((c) => c.status === 'proposed')
      .map((c) => ({
        id: c.id,
        kind: 'component' as const,
        title: c.label,
        detail: componentTypeInfo(c.type).label,
        model: by(c.origin),
      })),
    ...Object.values(d.connections)
      .filter((k) => k.status === 'proposed')
      .map((k) => ({
        id: k.id,
        kind: 'connection' as const,
        title: `${name(k.from)} → ${name(k.to)}`,
        detail: [k.protocol, k.mode, k.payload, k.volume].filter(Boolean).join(' · '),
        model: by(k.origin),
      })),
    ...d.scenarios
      .filter((s) => s.status === 'proposed')
      .map((s) => ({
        id: s.id,
        kind: 'scenario' as const,
        title: s.name,
        detail: `${s.steps.length} step(s)`,
        model: by(s.origin),
      })),
    ...d.doc.items
      .filter((i) => i.status === 'proposed')
      .map((i) => ({
        id: i.id,
        kind: 'doc-item' as const,
        title: i.text,
        detail: `${DOC_SECTION_LABEL[i.section]}${i.pins.length ? ` · ${i.pins.map(name).join(', ')}` : ''}`,
        model: by(i.origin),
      })),
  ];
}

const KIND_LABEL: Record<Row['kind'], string> = {
  component: 'Components',
  connection: 'Connections',
  scenario: 'Scenarios',
  'doc-item': 'Design doc',
};

/**
 * Agent proposals on a board (D03c): every proposed component, connection, scenario and doc item
 * with Accept / Reject, plus Accept all. Accepting makes an item active (drawn solid, still
 * labeled with the agent that proposed it); rejecting keeps it only in the audit record.
 */
export function ProposalsPanel({
  token,
  board,
  onReviewed,
}: {
  token: string;
  board: DesignBoard;
  onReviewed(): void;
}) {
  const rows = proposedRows(board);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // new proposals (another agent job) reopen the panel
  const seen = useRef(rows.length);
  useEffect(() => {
    if (rows.length > seen.current) setOpen(true);
    seen.current = rows.length;
  }, [rows.length]);
  if (!rows.length) return null;
  const review = async (body: { accept?: string[]; reject?: string[] }) => {
    setBusy(true);
    setError(undefined);
    const err = await reviewBoard(token, board.id, body);
    setBusy(false);
    if (err) setError(err);
    else onReviewed();
  };
  const groups = (['component', 'connection', 'scenario', 'doc-item'] as const)
    .map((k) => [k, rows.filter((r) => r.kind === k)] as const)
    .filter(([, rs]) => rs.length);
  return (
    <aside className="ba-panel ba-proposals" role="region" aria-label="Agent proposals">
      <header className="ba-panel-head">
        <button
          type="button"
          className="ba-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} Agent proposals <span className="ba-count">{rows.length}</span>
        </button>
        <button
          type="button"
          className="action-sm primary"
          disabled={busy}
          onClick={() => void review({ accept: rows.map((r) => r.id) })}
        >
          Accept all
        </button>
        <button
          type="button"
          className="action-sm"
          disabled={busy}
          onClick={() => void review({ reject: rows.map((r) => r.id) })}
        >
          Reject all
        </button>
      </header>
      {error && (
        <p role="alert" className="da-error">
          {error}
        </p>
      )}
      {open && (
        <div className="ba-panel-body">
          <p className="muted small">
            Proposed by an agent: dashed on the canvas until you accept them.
          </p>
          {groups.map(([kind, rs]) => (
            <section key={kind} aria-label={`Proposed ${KIND_LABEL[kind].toLowerCase()}`}>
              <h4>
                {KIND_LABEL[kind]} ({rs.length})
              </h4>
              <ul className="ba-list">
                {rs.map((r) => (
                  <li key={r.id} className="ba-item" data-proposal-id={r.id}>
                    <div className="ba-item-text">
                      <span className="ba-item-title">{r.title}</span>
                      <span className="ba-item-detail">
                        {r.detail ? `${r.detail} · ` : ''}
                        <span className="ba-agent">agent: {r.model}</span>
                      </span>
                    </div>
                    <span className="ba-item-actions">
                      <button
                        type="button"
                        className="action-sm"
                        disabled={busy}
                        aria-label={`Accept ${r.title}`}
                        onClick={() => void review({ accept: [r.id] })}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="action-sm"
                        disabled={busy}
                        aria-label={`Reject ${r.title}`}
                        onClick={() => void review({ reject: [r.id] })}
                      >
                        Reject
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
