import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DesignBoard } from '@atlas/schema';
import { ConsentScreen, Modal } from '../components/design/DesignAgentSettings.tsx';
import type { RuntimeId } from '../components/design/useDesignJobs.ts';
import { JobProgress } from './JobProgress.tsx';
import { PlanPanel } from './PlanPanel.tsx';
import { PromptDialog } from './PromptDialog.tsx';
import { useBoardJobs, type BoardJobDto, type BoardJobKind } from './useBoardJobs.ts';
import './board-agent.css';

type Pending = { kind: BoardJobKind; body: Record<string, unknown>; title: string };

/**
 * "Agent ▾" on a board (D03c): redraft from a prompt, critique, fill the design doc, explain a
 * scenario, propose a variant board, implementation plan. Runs on the configured runtime (mock
 * by default) behind the D02 consent gate; when a job ends the board reloads so its proposals
 * show (dashed) and the result panel says what happened.
 */
export function BoardAgentMenu({
  token,
  board,
  onReload,
  onOpen,
}: {
  token: string;
  board: DesignBoard;
  /** Re-read the board from the daemon (after a job or a review). */
  onReload(): void;
  /** Open another board (a proposed variant). */
  onOpen?(boardId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [dialog, setDialog] = useState<'redraft' | 'explain' | undefined>();
  const [scenarioId, setScenarioId] = useState<string>();
  const [consentFor, setConsentFor] = useState<Pending>();
  const [panel, setPanel] = useState<{ title: string; job?: BoardJobDto } | undefined>();
  const [plan, setPlan] = useState<{ text: string; model?: string }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const jobs = useBoardJobs(
    token,
    board.projectId,
    (job) => {
      if (job.state === 'succeeded') {
        if (job.kind === 'draft-board') setDialog(undefined);
        if (job.boardId === board.id || job.kind === 'implementation-plan') onReload();
        if (job.kind === 'implementation-plan' && job.result) {
          setPlan({ text: job.result, model: job.model });
          // the plan panel is the result: no second panel saying so
          setPanel(undefined);
          return;
        }
      }
      setPanel((p) => (p ? { ...p, job } : p));
    },
    used,
  );

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const scenarios = board.document.scenarios.filter((s) => s.status !== 'rejected');
  const start = async (p: Pending, runtime?: RuntimeId) => {
    setOpen(false);
    const rt = runtime ?? jobs.settings?.runtime ?? 'mock';
    if (rt !== 'mock' && jobs.settings && !jobs.settings.consented[rt]) {
      setConsentFor(p);
      return;
    }
    setPanel({ title: p.title });
    await jobs.run(p.kind, { boardId: board.id, ...p.body }, rt);
  };

  const item = (label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled || jobs.running}
      onClick={() => {
        setUsed(true);
        onClick();
      }}
    >
      {label}
    </button>
  );

  const job = panel ? jobs.job : undefined;
  return (
    <div className="ba-menu-wrap" ref={menuRef}>
      <button
        type="button"
        className="action-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setUsed(true);
          setOpen((o) => !o);
        }}
      >
        Agent ▾
      </button>
      {open && (
        <div className="ba-menu" role="menu" aria-label="Agent actions">
          {item('Redraft from a prompt…', () => {
            setOpen(false);
            setDialog('redraft');
          })}
          {item(
            'Critique this design',
            () => void start({ kind: 'critique-board', body: {}, title: 'Critique' }),
          )}
          {item(
            'Fill the design doc',
            () => void start({ kind: 'fill-doc', body: {}, title: 'Fill the design doc' }),
          )}
          {item(
            'Explain scenario…',
            () => {
              setOpen(false);
              setScenarioId(scenarios[0]?.id);
              setDialog('explain');
            },
            !scenarios.length,
          )}
          {item(
            'Propose a variant',
            () => void start({ kind: 'variant-board', body: {}, title: 'Variant board' }),
          )}
          {item('Implementation plan…', () => {
            setOpen(false);
            if (board.document.doc.plan) setPlan({ text: board.document.doc.plan });
            else
              void start({ kind: 'implementation-plan', body: {}, title: 'Implementation plan' });
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
                void start({
                  kind: 'explain-scenario',
                  body: scenarioId ? { scenarioId } : {},
                  title: 'Explain scenario',
                });
              }}
            >
              Explain
            </button>
          </div>
        </Modal>
      )}
      {consentFor && jobs.settings && (
        <Modal label="Consent" onClose={() => setConsentFor(undefined)}>
          <ConsentScreen
            runtime={jobs.settings.runtime}
            sends={jobs.settings.sends[jobs.settings.runtime]}
            onAgree={() => {
              const p = consentFor;
              setConsentFor(undefined);
              void jobs.consent(jobs.settings!.runtime).then((ok) => {
                if (ok) void start(p);
              });
            }}
            onCancel={() => setConsentFor(undefined)}
          />
        </Modal>
      )}

      <InBoard anchor={menuRef}>
        {panel && job && (
          <aside className="ba-panel ba-result" role="region" aria-label="Agent result">
            <header className="ba-panel-head">
              <strong>{panel.title}</strong>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close agent result"
                onClick={() => {
                  setPanel(undefined);
                  if (!jobs.running) jobs.clear();
                }}
              >
                ×
              </button>
            </header>
            <div className="ba-panel-body">
              <JobProgress jobs={jobs} title={panel.title} />
              {job.state === 'succeeded' && <Result job={job} board={board} onOpen={onOpen} />}
              {jobs.error && (
                <p role="alert" className="da-error">
                  {jobs.error}
                </p>
              )}
            </div>
          </aside>
        )}
        {!panel && jobs.error && (
          <p role="alert" className="da-error ba-inline-error">
            {jobs.error}
          </p>
        )}
        {plan && (
          <PlanPanel
            plan={plan.text}
            model={plan.model}
            busy={jobs.running}
            onClose={() => setPlan(undefined)}
            onRegenerate={() => {
              setPlan(undefined);
              void start({ kind: 'implementation-plan', body: {}, title: 'Implementation plan' });
            }}
          />
        )}
      </InBoard>
    </div>
  );
}

function Result({
  job,
  board,
  onOpen,
}: {
  job: BoardJobDto;
  board: DesignBoard;
  onOpen?(boardId: string): void;
}) {
  switch (job.kind) {
    case 'explain-scenario':
      return <div className="ba-explain">{job.result ?? job.output?.text}</div>;
    case 'variant-board':
      return (
        <p>
          {job.output?.text ?? 'A variant board was proposed.'}{' '}
          {job.boardId && job.boardId !== board.id && onOpen && (
            <button type="button" className="action-sm" onClick={() => onOpen(job.boardId!)}>
              Open variant
            </button>
          )}
        </p>
      );
    default:
      return (
        <p>
          {job.proposedBoardItems ?? 0} item(s) proposed
          {job.output?.text ? `: ${job.output.text}` : '.'} Review them under Agent proposals.
        </p>
      );
  }
}

/** Result and plan panels float over the board (not the small menu button they belong to). */
function InBoard({
  anchor,
  children,
}: {
  anchor: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(anchor.current?.closest('.board-view') ?? null);
  }, [anchor]);
  return host ? createPortal(children, host) : <>{children}</>;
}
