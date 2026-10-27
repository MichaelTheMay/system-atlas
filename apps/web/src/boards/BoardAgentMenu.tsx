import { useEffect, useRef, useState } from 'react';
import { ConsentScreen, Modal } from '../components/design/DesignAgentSettings.tsx';
import { useBoardAgent } from './agentContext.tsx';
import { useBoard } from './context.ts';
import { PromptDialog } from './PromptDialog.tsx';
import './board-agent.css';

/**
 * "Agent ▾" in the board header (D03c): redraft from a prompt, critique, fill the design doc,
 * explain a scenario, propose a variant board, implementation plan. Runs on the configured
 * runtime (mock by default) behind the D02 consent gate; progress, results and proposals show in
 * the inspector's Proposals / Plan tabs.
 */
export function BoardAgentMenu() {
  const { board } = useBoard();
  const agent = useBoardAgent();
  const { jobs } = agent;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'redraft' | 'explain' | undefined>();
  const [scenarioId, setScenarioId] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  // a redraft that finished closes its dialog (its proposals are in the Proposals tab)
  useEffect(() => {
    if (dialog === 'redraft' && jobs.job?.kind === 'draft-board' && jobs.job.finishedAt)
      setDialog(undefined);
  }, [dialog, jobs.job]);

  const scenarios = board.document.scenarios.filter((s) => s.status !== 'rejected');
  const item = (label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled || jobs.running}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="ba-menu-wrap" ref={menuRef}>
      <button
        type="button"
        className="action-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          agent.enable();
          setOpen((o) => !o);
        }}
      >
        Agent ▾
      </button>
      {open && (
        <div className="ba-menu" role="menu" aria-label="Agent actions">
          {item('Redraft from a prompt…', () => setDialog('redraft'))}
          {item('Critique this design', () => void agent.start('critique-board', 'Critique'))}
          {item('Fill the design doc', () => void agent.start('fill-doc', 'Fill the design doc'))}
          {item(
            'Explain scenario…',
            () => {
              setScenarioId(scenarios[0]?.id);
              setDialog('explain');
            },
            !scenarios.length,
          )}
          {item('Propose a variant', () => void agent.start('variant-board', 'Variant board'))}
          {item('Implementation plan…', () => {
            if (board.document.doc.plan) agent.setTab('plan');
            else void agent.start('implementation-plan', 'Implementation plan');
          })}
          <p className="ba-menu-note">
            Runtime: {jobs.settings?.runtime ?? 'mock'}. Results land as proposals.
          </p>
        </div>
      )}

      {dialog === 'redraft' && (
        <PromptDialog jobs={jobs} boardId={board.id} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'explain' && (
        <Modal label="Explain scenario" onClose={() => setDialog(undefined)}>
          <h2>Explain scenario</h2>
          <label className="field">
            <span className="field-label">Scenario</span>
            <select
              aria-label="Scenario"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="da-buttons">
            <button
              type="button"
              className="action-sm primary"
              onClick={() => {
                setDialog(undefined);
                void agent.start(
                  'explain-scenario',
                  'Explain scenario',
                  scenarioId ? { scenarioId } : {},
                );
              }}
            >
              Explain
            </button>
          </div>
        </Modal>
      )}
      {agent.pendingConsent && jobs.settings && (
        <Modal label="Consent" onClose={agent.cancelConsent}>
          <ConsentScreen
            runtime={jobs.settings.runtime}
            sends={jobs.settings.sends[jobs.settings.runtime]}
            onAgree={() => void agent.agreeAndStart()}
            onCancel={agent.cancelConsent}
          />
        </Modal>
      )}
      {jobs.error && !agent.last && (
        <p role="alert" className="da-error ba-inline-error">
          {jobs.error}
        </p>
      )}
    </div>
  );
}
