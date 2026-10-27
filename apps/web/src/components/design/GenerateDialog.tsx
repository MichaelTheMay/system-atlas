import { useEffect, useState } from 'react';
import './design-agent.css';
import { ConsentScreen, Modal } from './DesignAgentSettings.tsx';
import { ReviewSheet } from './ReviewSheet.tsx';
import {
  call,
  errorText,
  isTerminal,
  RUNTIME_LABEL,
  RUNTIMES,
  type DesignAgentSettingsDto,
  type DesignJobsApi,
  type EstimateDto,
  type RuntimeId,
} from './useDesignJobs.ts';

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * "Generate design…" (D02b/D02c): confirm what runs and what leaves the machine, then follow the
 * job's progress (SSE) with Cancel, then review the proposals. Manual only.
 */
export function GenerateDialog({
  token,
  projectId,
  snapshotId,
  settings,
  jobs,
  onSettingsChanged,
  onOpenRun,
  onChanged,
  onClose,
}: {
  token: string;
  projectId: string;
  /** Latest snapshot: the job reads it and proposals are validated against it. */
  snapshotId: string;
  settings: DesignAgentSettingsDto | null;
  jobs: DesignJobsApi;
  onSettingsChanged(s: DesignAgentSettingsDto): void;
  onOpenRun(runId: string): void;
  onChanged(): void;
  onClose(): void;
}) {
  const [runtime, setRuntime] = useState<RuntimeId>(settings?.runtime ?? 'mock');
  const [model, setModel] = useState(settings?.model ?? '');
  const [depth, setDepth] = useState(3);
  const [maxPerLevel, setMaxPerLevel] = useState(8);
  const [replace, setReplace] = useState(false);
  const [estimate, setEstimate] = useState<EstimateDto | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Set once this dialog started a job: from then on it shows progress, then the review. */
  const [started, setStarted] = useState(() => jobs.active?.job.kind === 'generate');
  const job = jobs.active?.job.kind === 'generate' ? jobs.active : null;

  useEffect(() => {
    let cancelled = false;
    setEstimate(null);
    void call<EstimateDto>(
      token,
      'GET',
      `/projects/${projectId}/design/jobs/estimate?depth=${depth}&runtime=${runtime}&snapshotId=${snapshotId}`,
    ).then((r) => {
      if (cancelled) return;
      if (r.ok) setEstimate(r.body);
      else setError(errorText(r));
    });
    return () => {
      cancelled = true;
    };
  }, [token, projectId, snapshotId, depth, runtime, settings?.consented]);

  const consented = runtime === 'mock' || !!settings?.consented[runtime];
  const available = settings?.availability[runtime]?.available ?? runtime === 'mock';
  const tokens = estimate ? estimate.estimatedInputTokens + estimate.estimatedOutputTokens : 0;
  const overBudget =
    runtime === 'anthropic-api' && !!estimate && tokens > estimate.dailyBudget.remaining;

  const agree = async () => {
    setBusy(true);
    const r = await call<DesignAgentSettingsDto>(token, 'PUT', '/settings/design-agent', {
      runtime,
      consent: true,
    });
    setBusy(false);
    if (r.ok) onSettingsChanged(r.body);
    else setError(errorText(r));
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    const err = await jobs.start({
      kind: 'generate',
      runtime,
      ...(runtime !== 'mock' && model.trim() ? { model: model.trim() } : {}),
      snapshotId,
      depth,
      maxSubsystemsPerLevel: maxPerLevel,
      replaceProposals: replace,
    });
    setBusy(false);
    if (err) setError(err);
    else setStarted(true);
  };

  const close = () => {
    if (job && isTerminal(job.job.state)) jobs.clear();
    onClose();
  };

  // ---- progress and review ------------------------------------------------------------------
  if (started && job) {
    const j = job.job;
    return (
      <Modal label="Generate design" onClose={close} wide>
        <h2>Generate design</h2>
        <p className="muted small">
          {RUNTIME_LABEL[j.runtime]} · agent: {j.model ?? 'unknown'} · job {j.id.slice(0, 12)}
        </p>
        {!isTerminal(j.state) && (
          <section className="da-progress" role="region" aria-label="Progress">
            <p role="status">
              <span className="da-spinner" aria-hidden /> Generating… ({j.state})
            </p>
            <ol className="da-log">
              {job.progress.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
            <button type="button" className="action-sm" onClick={() => void jobs.cancel()}>
              Cancel
            </button>
          </section>
        )}
        {j.state === 'failed' || j.state === 'canceled' ? (
          <div role="alert" className="da-error">
            <p>
              Generation {j.state}
              {j.error ? `: ${j.error}` : ''}. Nothing was accepted; earlier work is unchanged.
            </p>
            {j.runId && (
              <button type="button" className="action-sm" onClick={() => onOpenRun(j.runId!)}>
                Open run in Outputs &amp; Audit
              </button>
            )}
          </div>
        ) : j.state === 'succeeded' ? (
          <>
            <p className="muted small" role="status">
              Done: {j.proposedClaims ?? 0} proposed claim{j.proposedClaims === 1 ? '' : 's'}
              {j.usage?.inputTokens !== undefined
                ? ` · ${fmt((j.usage.inputTokens ?? 0) + (j.usage.outputTokens ?? 0))} tokens reported`
                : ''}
              .
            </p>
            <ReviewSheet
              token={token}
              projectId={projectId}
              snapshotId={snapshotId}
              runId={j.runId}
              onOpenRun={onOpenRun}
              onChanged={onChanged}
            />
          </>
        ) : null}
      </Modal>
    );
  }

  // ---- confirm --------------------------------------------------------------------------------
  return (
    <Modal label="Generate design" onClose={close} wide>
      <h2>Generate design</h2>
      <p className="muted small">
        An agent groups the boxes of this snapshot into subsystems, top-down, through the Atlas
        tools with citations. Everything lands as <strong>proposed</strong> for your review;
        accepted and hand-made work is never replaced.
      </p>
      <div className="da-grid">
        <label className="field">
          <span className="field-label">Runtime</span>
          <select
            aria-label="Runtime"
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as RuntimeId)}
          >
            {RUNTIMES.map((r) => (
              <option key={r} value={r}>
                {RUNTIME_LABEL[r]}
                {settings && !settings.availability[r]?.available ? ' (unavailable)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <input
            aria-label="Generate model"
            value={runtime === 'mock' ? 'mock-design' : model}
            disabled={runtime === 'mock'}
            placeholder={estimate?.model ?? 'runtime default'}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Depth</span>
          <select
            aria-label="Depth"
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          >
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d} level{d === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Max subsystems per level</span>
          <input
            aria-label="Max subsystems per level"
            type="number"
            min={2}
            max={12}
            value={maxPerLevel}
            onChange={(e) => setMaxPerLevel(Math.min(12, Math.max(2, Number(e.target.value) || 8)))}
          />
        </label>
      </div>

      <fieldset className="da-choice">
        <legend>Earlier proposals</legend>
        <label>
          <input type="radio" checked={!replace} onChange={() => setReplace(false)} /> Keep them and
          add new proposals
        </label>
        <label>
          <input type="radio" checked={replace} onChange={() => setReplace(true)} /> Replace earlier
          agent proposals (accepted and hand-made work is never replaced)
        </label>
      </fieldset>

      <section className="da-estimate" role="region" aria-label="Estimate">
        {estimate ? (
          <>
            <p>
              <strong>What leaves this machine.</strong> {estimate.sends}
            </p>
            <p>
              <strong>Estimated tokens:</strong> ~{fmt(estimate.estimatedInputTokens)} in, ~
              {fmt(estimate.estimatedOutputTokens)} out for {estimate.units} box
              {estimate.units === 1 ? '' : 'es'} (a rough upper estimate).
            </p>
            <p className={overBudget ? 'warn' : 'muted small'}>
              Daily budget: {fmt(estimate.dailyBudget.remaining)} of{' '}
              {fmt(estimate.dailyBudget.maxTokensPerDay)} tokens left today
              {runtime === 'anthropic-api'
                ? overBudget
                  ? ': this run would exceed it.'
                  : '.'
                : runtime === 'mock'
                  ? ' (the mock costs nothing).'
                  : ' (applies to the API-key runtime; Claude Code usage counts against your Claude plan).'}
            </p>
          </>
        ) : (
          <p className="muted">Estimating…</p>
        )}
      </section>

      {!consented && settings && (
        <ConsentScreen
          runtime={runtime}
          sends={settings.sends[runtime]}
          busy={busy}
          onAgree={() => void agree()}
        />
      )}
      {consented && !available && (
        <p className="warn" role="status">
          {RUNTIME_LABEL[runtime]} is unavailable: {settings?.availability[runtime]?.detail}
        </p>
      )}
      {error && (
        <p className="da-error" role="alert">
          {error}
        </p>
      )}
      <div className="da-buttons da-footer">
        <button
          type="button"
          className="action"
          disabled={busy || !consented || !available || !estimate || overBudget}
          onClick={() => void run()}
        >
          Generate
        </button>
        <button type="button" className="action-sm" onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
