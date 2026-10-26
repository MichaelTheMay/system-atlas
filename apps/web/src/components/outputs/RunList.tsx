import { useMemo, useState } from 'react';
import type { RunSummaryDto } from '../../api.ts';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failures' },
  { id: 'browser', label: 'Browser' },
  { id: 'process', label: 'Commands' },
] as const;

export function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <span className={`chip chip-${value}`}>
      {label} {value}
    </span>
  );
}

/** Outputs overview (plan §10): recent runs with process and task outcome kept separate. */
export function RunList({
  runs,
  currentId,
  latestSnapshotId,
  onOpen,
}: {
  runs: RunSummaryDto[];
  currentId?: string;
  latestSnapshotId?: string;
  onOpen(id: string): void;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const shown = useMemo(
    () =>
      runs.filter((r) =>
        filter === 'all'
          ? true
          : filter === 'failed'
            ? r.outcome.process !== 'succeeded' || r.outcome.task === 'failed'
            : filter === 'browser'
              ? r.run.adapter === 'playwright'
              : r.run.adapter === 'process',
      ),
    [runs, filter],
  );
  return (
    <section className="run-list" aria-label="Runs">
      <div className="filters" role="tablist" aria-label="Filter runs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? 'filter active' : 'filter'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 && (
        <p className="empty-note">
          No runs{filter !== 'all' ? ' match this filter' : ' recorded yet'}.
        </p>
      )}
      <ul className="cards">
        {shown.map((r) => (
          <li key={r.run.id}>
            <button
              type="button"
              className={`run-card ${r.run.id === currentId ? 'current' : ''}`}
              onClick={() => onOpen(r.run.id)}
              aria-current={r.run.id === currentId ? 'true' : undefined}
            >
              <div className="rc-head">
                <span className="rc-adapter">
                  {r.run.adapter === 'playwright'
                    ? '◉ browser'
                    : r.run.adapter === 'process'
                      ? '▶ command'
                      : r.run.adapter}
                </span>
                <time dateTime={r.run.startAt}>{new Date(r.run.startAt).toLocaleString()}</time>
              </div>
              <div className="rc-title">{r.run.commandSummary ?? r.run.id}</div>
              <div className="rc-chips">
                <StatusChip label="process" value={r.outcome.process} />
                <StatusChip label="task" value={r.outcome.task} />
                {r.counts.screenshots > 0 && (
                  <span className="chip">{r.counts.screenshots} screenshots</span>
                )}
                <span className="chip">{r.counts.artifacts} artifacts</span>
                {r.counts.missingArtifacts > 0 && (
                  <span className="chip chip-missing">{r.counts.missingArtifacts} missing</span>
                )}
              </div>
              <div className="rc-snap">
                {r.run.snapshotId
                  ? r.run.snapshotId === latestSnapshotId
                    ? 'ran on the current snapshot'
                    : 'ran on an earlier snapshot'
                  : 'source not snapshotted'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
