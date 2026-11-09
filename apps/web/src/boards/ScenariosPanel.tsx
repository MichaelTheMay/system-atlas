import { useCallback, useEffect, useState } from 'react';
import type { BoardDocument, Scenario } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { useBoard } from './context.ts';
import { Player } from './Player.tsx';
import {
  clearDecorations,
  connectionTitle,
  newLocalId,
  shownScenarioId,
  showScenario,
} from './scenarios.ts';
import { SequenceView } from './SequenceView.tsx';

type Step = Scenario['steps'][number];

/**
 * Scenarios of a board (D03 wave 1b): named request flows whose ordered steps each take a hop (a
 * connection) or happen in a component. `document.scenarios` is the source of truth; "Show" draws
 * the step numbers on the canvas (one scenario at a time), with a sequence view and a player.
 */
export function ScenariosPanel() {
  const { board, api, patchDocument, selection } = useBoard();
  const doc = board.document;
  const scenarios = doc.scenarios.filter((s) => s.status !== 'rejected');
  const [openId, setOpenId] = useState<string | undefined>(scenarios[0]?.id);
  const [shown, setShown] = useState<string | undefined>();
  const [renaming, setRenaming] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [view, setView] = useState<'steps' | 'sequence' | 'player'>('steps');

  // the shown scenario is whatever step numbers are on the canvas (survives panel switches)
  useEffect(() => {
    if (api) setShown(shownScenarioId(api.getSceneElements()));
  }, [api]);

  const apply = useCallback(
    (d: BoardDocument, s: Scenario | undefined, focus = false) => {
      if (!api) return;
      const scene = api.getSceneElements();
      const next = s ? showScenario(d, s, scene) : clearDecorations(scene);
      api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.NEVER });
      setShown(s?.id);
      // bring the path (everything not dimmed) into view
      const onPath = next.filter(
        (e) => (e.customData as { atlasDim?: number } | undefined)?.atlasDim === undefined,
      );
      if (focus && s && onPath.length)
        api.scrollToContent(onPath as never, {
          fitToViewport: true,
          viewportZoomFactor: 0.9,
          animate: true,
        });
    },
    [api],
  );

  /** Edit one scenario; if it is on the canvas, redraw its numbers. */
  const update = (id: string, fn: (s: Scenario) => Scenario | null) => {
    let next: BoardDocument | undefined;
    patchDocument((d) => {
      next = {
        ...d,
        scenarios: d.scenarios.flatMap((s) => {
          if (s.id !== id) return [s];
          const r = fn(s);
          return r ? [r] : [];
        }),
      };
      return next;
    });
    if (next && shown === id)
      apply(
        next,
        next.scenarios.find((s) => s.id === id),
      );
  };

  const create = () => {
    const s: Scenario = {
      id: newLocalId('sc'),
      name: `Scenario ${doc.scenarios.length + 1}`,
      steps: [],
      origin: { author: 'user' },
      status: 'active',
    };
    patchDocument((d) => ({ ...d, scenarios: [...d.scenarios, s] }));
    setOpenId(s.id);
    setRenaming(s.id);
  };

  const conns = Object.values(doc.connections).filter((k) => k.status !== 'rejected');
  const comps = Object.values(doc.components).filter((c) => c.status !== 'rejected');
  const targetOf = (st: Step) =>
    st.connectionId ? `k:${st.connectionId}` : st.componentId ? `c:${st.componentId}` : '';
  const withTarget = (st: Step, v: string): Step => {
    const { connectionId: _k, componentId: _c, ...rest } = st;
    if (v.startsWith('k:')) return { ...rest, connectionId: v.slice(2) };
    if (v.startsWith('c:')) return { ...rest, componentId: v.slice(2) };
    return rest;
  };
  const selectionTarget = selection.connectionId
    ? `k:${selection.connectionId}`
    : selection.componentId
      ? `c:${selection.componentId}`
      : '';

  return (
    <div className="scenarios-panel">
      <div className="panel-head">
        <h3>Scenarios</h3>
        <button type="button" onClick={create}>
          New scenario
        </button>
      </div>
      {scenarios.length === 0 && (
        <p className="boards-hint">
          A scenario is a request flow told step by step: each step takes a connection or happens in
          a component.
        </p>
      )}
      <ul className="scenario-list">
        {scenarios.map((s) => {
          const open = openId === s.id;
          return (
            <li key={s.id} className={`scenario${open ? ' open' : ''}`}>
              <div className="scenario-head">
                {renaming === s.id ? (
                  <input
                    aria-label="Scenario name"
                    defaultValue={s.name}
                    autoFocus
                    maxLength={120}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== s.name) update(s.id, (x) => ({ ...x, name }));
                      setRenaming(undefined);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(undefined);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="scenario-name"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? undefined : s.id)}
                  >
                    {s.name}
                    <span className="scenario-count">{s.steps.length} step(s)</span>
                  </button>
                )}
                {s.status === 'proposed' && <span className="chip chip-agent">agent</span>}
                <button
                  type="button"
                  aria-pressed={shown === s.id}
                  onClick={() => apply(doc, shown === s.id ? undefined : s, true)}
                  disabled={!api}
                >
                  {shown === s.id ? 'Hide' : 'Show'}
                </button>
              </div>
              {open && (
                <div className="scenario-body">
                  <div className="scenario-tools">
                    <div className="seg" role="group" aria-label="Scenario view">
                      {(['steps', 'sequence', 'player'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={view === v}
                          onClick={() => setView(v)}
                        >
                          {v === 'steps' ? 'Steps' : v === 'sequence' ? 'Sequence view' : 'Player'}
                        </button>
                      ))}
                    </div>
                    <span className="scenario-actions">
                      <button type="button" className="link-btn" onClick={() => setRenaming(s.id)}>
                        Rename
                      </button>
                      {confirmDelete === s.id ? (
                        <>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              if (shown === s.id) apply(doc, undefined);
                              update(s.id, () => null);
                              setConfirmDelete(undefined);
                            }}
                          >
                            Confirm delete
                          </button>
                          <button type="button" onClick={() => setConfirmDelete(undefined)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => setConfirmDelete(s.id)}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </div>
                  {view === 'sequence' ? (
                    <SequenceView scenario={s} />
                  ) : view === 'player' ? (
                    <Player
                      scenario={s}
                      onStart={() => {
                        if (shown !== s.id) apply(doc, s);
                      }}
                    />
                  ) : (
                    <>
                      <ol className="steps">
                        {s.steps.map((st, i) => (
                          <li key={st.id} className="step">
                            <span className="step-num" aria-hidden>
                              {i + 1}
                            </span>
                            <div className="step-fields">
                              <select
                                aria-label={`Step ${i + 1} target`}
                                value={targetOf(st)}
                                onChange={(e) =>
                                  update(s.id, (x) => ({
                                    ...x,
                                    steps: x.steps.map((y) =>
                                      y.id === st.id ? withTarget(y, e.target.value) : y,
                                    ),
                                  }))
                                }
                              >
                                <option value="">— choose a hop or component —</option>
                                <optgroup label="Connections">
                                  {conns.map((k) => (
                                    <option key={k.id} value={`k:${k.id}`}>
                                      {connectionTitle(doc, k)}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="Components">
                                  {comps.map((c) => (
                                    <option key={c.id} value={`c:${c.id}`}>
                                      {c.label}
                                    </option>
                                  ))}
                                </optgroup>
                              </select>
                              <textarea
                                aria-label={`Step ${i + 1} text`}
                                defaultValue={st.text}
                                rows={2}
                                maxLength={500}
                                placeholder="What happens in this step"
                                onBlur={(e) => {
                                  const text = e.target.value;
                                  if (text !== st.text)
                                    update(s.id, (x) => ({
                                      ...x,
                                      steps: x.steps.map((y) =>
                                        y.id === st.id ? { ...y, text } : y,
                                      ),
                                    }));
                                }}
                              />
                            </div>
                            <div className="step-actions">
                              <button
                                type="button"
                                aria-label={`Move step ${i + 1} up`}
                                disabled={i === 0}
                                onClick={() =>
                                  update(s.id, (x) => {
                                    const steps = [...x.steps];
                                    [steps[i - 1], steps[i]] = [steps[i]!, steps[i - 1]!];
                                    return { ...x, steps };
                                  })
                                }
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                aria-label={`Move step ${i + 1} down`}
                                disabled={i === s.steps.length - 1}
                                onClick={() =>
                                  update(s.id, (x) => {
                                    const steps = [...x.steps];
                                    [steps[i + 1], steps[i]] = [steps[i]!, steps[i + 1]!];
                                    return { ...x, steps };
                                  })
                                }
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete step ${i + 1}`}
                                onClick={() =>
                                  update(s.id, (x) => ({
                                    ...x,
                                    steps: x.steps.filter((y) => y.id !== st.id),
                                  }))
                                }
                              >
                                ✕
                              </button>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="scenario-add">
                        <button
                          type="button"
                          onClick={() =>
                            update(s.id, (x) => ({
                              ...x,
                              steps: [...x.steps, { id: newLocalId('st'), text: '' }],
                            }))
                          }
                        >
                          Add step
                        </button>
                        <button
                          type="button"
                          disabled={!selectionTarget}
                          title={
                            selectionTarget
                              ? undefined
                              : 'Select a connection or component on the canvas first'
                          }
                          onClick={() =>
                            update(s.id, (x) => ({
                              ...x,
                              steps: [
                                ...x.steps,
                                withTarget({ id: newLocalId('st'), text: '' }, selectionTarget),
                              ],
                            }))
                          }
                        >
                          Add step from selection
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
