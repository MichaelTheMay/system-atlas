import { RUNTIME_LABEL } from '../components/design/useDesignJobs.ts';
import type { BoardJobs } from './useBoardJobs.ts';

/** Progress of the running board job (from `design.job` SSE), with Cancel; errors when it failed. */
export function JobProgress({ jobs, title }: { jobs: BoardJobs; title: string }) {
  const j = jobs.job;
  if (!j) return null;
  return (
    <section className="ba-progress" role="region" aria-label="Agent progress">
      <p className="muted small">
        {RUNTIME_LABEL[j.runtime]} · agent: {j.model ?? 'unknown'}
      </p>
      {jobs.running ? (
        <>
          <p role="status">
            <span className="da-spinner" aria-hidden /> {title}… ({j.state})
          </p>
          <ol className="da-log">
            {jobs.progress.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
          <button type="button" className="action-sm" onClick={() => void jobs.cancel()}>
            Cancel
          </button>
        </>
      ) : j.state === 'succeeded' ? (
        <p role="status">Done.</p>
      ) : (
        <p role="alert" className="da-error">
          {title} {j.state}
          {j.error ? `: ${j.error}` : ''}. Nothing on the board was changed.
        </p>
      )}
    </section>
  );
}
