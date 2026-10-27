import type { ReactNode } from 'react';
import { useBoardAgent, type InspectorTab } from './agentContext.tsx';
import { useBoard } from './context.ts';
import { JobProgress } from './JobProgress.tsx';
import { PlanPanel } from './PlanPanel.tsx';
import { proposedRows, ProposalsPanel } from './ProposalsPanel.tsx';
import type { BoardJobDto } from './useBoardJobs.ts';
import './board-agent.css';

/**
 * Tabs of the board inspector: the 1a properties form, 1b's scenarios and design doc, and (D03c)
 * the agent's proposals (with the last job's progress and result) and the implementation plan.
 */
export function AgentTabs({
  properties,
  scenarios,
  doc,
}: {
  properties: ReactNode;
  scenarios: ReactNode;
  doc: ReactNode;
}) {
  const { board } = useBoard();
  const agent = useBoardAgent();
  const count = proposedRows(board).length;
  const tabs: [InspectorTab, string][] = [
    ['properties', 'Properties'],
    ['scenarios', 'Scenarios'],
    ['doc', 'Design doc'],
    ['proposals', count ? `Proposals (${count})` : 'Proposals'],
    ['plan', 'Plan'],
  ];
  return (
    <>
      <div className="ba-tabs" role="tablist" aria-label="Board panels">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={agent.tab === id}
            className={agent.tab === id ? 'active' : ''}
            onClick={() => agent.setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {agent.tab === 'scenarios' || agent.tab === 'doc' ? (
        // 1b's panels keep their own tab panel names
        <section
          className="board-side"
          role="tabpanel"
          aria-label={agent.tab === 'scenarios' ? 'Scenarios' : 'Design doc'}
        >
          {agent.tab === 'scenarios' ? scenarios : doc}
        </section>
      ) : (
        <div role="tabpanel" aria-label={tabs.find(([id]) => id === agent.tab)![1]}>
          {agent.tab === 'properties' ? (
            properties
          ) : agent.tab === 'proposals' ? (
            <>
              <AgentResult />
              <ProposalsPanel />
              {!count && !agent.last && (
                <p className="muted small">
                  No proposals. Use Agent ▾ to draft, critique or fill the design doc; what the
                  agent suggests waits here for you to accept or reject.
                </p>
              )}
            </>
          ) : board.document.doc.plan ? (
            <PlanPanel
              plan={board.document.doc.plan}
              busy={agent.jobs.running}
              onRegenerate={() => void agent.start('implementation-plan', 'Implementation plan')}
            />
          ) : (
            <div className="ba-empty">
              <p className="muted small">No implementation plan yet.</p>
              <button
                type="button"
                className="action-sm primary"
                disabled={agent.jobs.running}
                onClick={() => {
                  agent.enable();
                  void agent.start('implementation-plan', 'Implementation plan');
                }}
              >
                Write the implementation plan
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Progress of the last job started on this board, then what it produced. */
function AgentResult() {
  const { board, openBoard } = useBoard();
  const agent = useBoardAgent();
  const last = agent.last;
  const job = last && agent.jobs.job;
  if (!last || !job) return null;
  return (
    <section className="ba-card" role="region" aria-label="Agent result">
      <header className="ba-panel-head">
        <strong>{last.title}</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close agent result"
          onClick={agent.clearLast}
        >
          ×
        </button>
      </header>
      <JobProgress jobs={agent.jobs} title={last.title} />
      {job.state === 'succeeded' && job.finishedAt && (
        <Result job={job} boardId={board.id} onOpen={openBoard} />
      )}
      {agent.jobs.error && (
        <p role="alert" className="da-error">
          {agent.jobs.error}
        </p>
      )}
    </section>
  );
}

function Result({
  job,
  boardId,
  onOpen,
}: {
  job: BoardJobDto;
  boardId: string;
  onOpen(boardId: string): void;
}) {
  switch (job.kind) {
    case 'explain-scenario':
      return <div className="ba-explain">{job.result ?? job.output?.text}</div>;
    case 'variant-board':
      return (
        <p>
          {job.output?.text ?? 'A variant board was proposed.'}{' '}
          {job.boardId && job.boardId !== boardId && (
            <button type="button" className="action-sm" onClick={() => onOpen(job.boardId!)}>
              Open variant
            </button>
          )}
        </p>
      );
    case 'implementation-plan':
      return <p>Written to the Plan tab.</p>;
    default:
      return (
        <p>
          {job.proposedBoardItems ?? 0} item(s) proposed
          {job.output?.text ? `: ${job.output.text}` : '.'}
        </p>
      );
  }
}
