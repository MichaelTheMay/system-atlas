import { useEffect, useState } from 'react';
import { ConsentScreen, Modal } from '../components/design/DesignAgentSettings.tsx';
import { RUNTIME_LABEL, RUNTIMES, type RuntimeId } from '../components/design/useDesignJobs.ts';
import { JobProgress } from './JobProgress.tsx';
import type { BoardJobs } from './useBoardJobs.ts';
import './board-agent.css';

/**
 * "Draft from a prompt" (D03c): what to design, which runtime, and — for a runtime that sends
 * data off the machine — the one-time consent screen first. On a board it redrafts: the agent
 * proposes only what is missing. Everything lands as proposed for review.
 */
export function PromptDialog({
  jobs,
  boardId,
  onClose,
}: {
  jobs: BoardJobs;
  /** Redraft inside this board instead of drafting a new one. */
  boardId?: string;
  onClose(): void;
}) {
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>(jobs.settings?.runtime ?? 'mock');
  const [started, setStarted] = useState(false);
  const configured = jobs.settings !== null;
  useEffect(() => {
    if (configured && jobs.settings) setRuntime(jobs.settings.runtime);
    // once, when the settings arrive
  }, [configured]);
  const consented = runtime === 'mock' || !!jobs.settings?.consented[runtime];
  const job = started && jobs.job?.kind === 'draft-board' ? jobs.job : undefined;
  const title = boardId ? 'Redraft from a prompt' : 'Start from a prompt';

  const submit = async () => {
    const ok = await jobs.run(
      'draft-board',
      { prompt: prompt.trim(), ...(boardId ? { boardId } : {}) },
      runtime,
    );
    if (ok) setStarted(true);
  };

  return (
    <Modal label={title} onClose={onClose} wide>
      <h2>{title}</h2>
      {job ? (
        <JobProgress jobs={jobs} title="Drafting" />
      ) : !consented && jobs.settings ? (
        <ConsentScreen
          runtime={runtime}
          sends={jobs.settings.sends[runtime]}
          onAgree={() => void jobs.consent(runtime)}
          onCancel={() => setRuntime('mock')}
        />
      ) : (
        <form
          className="ba-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim()) void submit();
          }}
        >
          <p className="muted small">
            {boardId
              ? 'The agent proposes what this board is missing for the prompt; nothing you drew is changed.'
              : 'The agent drafts a new board for the prompt. Every component, connection and doc item lands as proposed (dashed) until you accept it.'}
          </p>
          <label className="field">
            <span className="field-label">What should the system do?</span>
            <textarea
              aria-label="Design prompt"
              rows={4}
              maxLength={4000}
              value={prompt}
              autoFocus
              placeholder="Design a URL shortener with click analytics"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
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
                  {jobs.settings && !jobs.settings.availability[r]?.available
                    ? ' (unavailable)'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {jobs.settings && <p className="muted small">{jobs.settings.sends[runtime]}</p>}
          {jobs.error && (
            <p role="alert" className="da-error">
              {jobs.error}
            </p>
          )}
          <div className="da-buttons">
            <button
              type="submit"
              className="action-sm primary"
              disabled={!prompt.trim() || jobs.running}
            >
              Draft board
            </button>
            <button type="button" className="action-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
