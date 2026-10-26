import { useCallback, useEffect, useState } from 'react';
import { api, apiOptional, type RunDetailDto, type RunSummaryDto } from '../../api.ts';
import { RunDetail } from './RunDetail.tsx';
import { RunList } from './RunList.tsx';

interface Props {
  token: string;
  projectId: string;
  latestSnapshotId?: string;
  runId?: string;
  refreshKey: number;
  onOpenRun(id: string | undefined): void;
  onOpenEntity(snapshotId: string, entityId: string): void;
}

/** Outputs & Audit root (plan §10): run overview and the selected run's detail. */
export function OutputsView({
  token,
  projectId,
  latestSnapshotId,
  runId,
  refreshKey,
  onOpenRun,
  onOpenEntity,
}: Props) {
  const [runs, setRuns] = useState<RunSummaryDto[] | null>(null);
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ runs: RunSummaryDto[] }>(`/projects/${projectId}/runs?limit=100`, token);
    setRuns(r.runs);
  }, [token, projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }
    void apiOptional<RunDetailDto>(`/runs/${runId}`, token).then(setDetail);
  }, [token, runId, refreshKey]);

  if (!runs)
    return (
      <div className="outputs">
        <p className="empty-note">Loading runs…</p>
      </div>
    );
  if (runs.length === 0) {
    return (
      <div className="flow">
        <div className="empty-canvas" role="status">
          <h2>No runs recorded yet</h2>
          <p>Runs captured with atlas run or the Playwright capture helper appear here.</p>
          <code>atlas run -- npm test</code>
        </div>
      </div>
    );
  }
  return (
    <div className="outputs">
      <RunList
        runs={runs}
        currentId={runId}
        latestSnapshotId={latestSnapshotId}
        onOpen={(id) => onOpenRun(id)}
      />
      <div className="outputs-main">
        {detail ? (
          <RunDetail
            key={detail.run.id}
            token={token}
            detail={detail}
            latestSnapshotId={latestSnapshotId}
            onOpenEntity={onOpenEntity}
          />
        ) : (
          <p className="empty-note pad">
            Select a run to see its steps, screenshots, output and audit trail.
          </p>
        )}
      </div>
    </div>
  );
}
