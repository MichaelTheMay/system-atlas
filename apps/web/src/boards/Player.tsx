import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scenario } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { useBoard } from './context.ts';
import { flowSession, useFlowSession, type FlowPending } from './flowSession.ts';
import { clearHighlight, highlightStep, stepTargets } from './scenarios.ts';

const PLAY_INTERVAL_MS = 1500;

/**
 * Step-through player for a scenario (D03 wave 1b): highlights the current hop (thicker, coloured
 * stroke), shows the step's text and moves the camera to it. Leaving (or switching scenario)
 * restores the original strokes. `onStart` lets the caller make sure the scenario is shown.
 *
 * A step that drills into an internals board (D04) can be followed down: the player opens that
 * board, plays the flow there, and comes back to the step after. Opening a board remounts this
 * component, so the position travels in `flowSession`; `resume` is what this board should show
 * on arrival.
 */
export function Player({
  scenario,
  onStart,
  resume,
}: {
  scenario: Scenario;
  onStart?: () => void;
  resume?: FlowPending;
}) {
  const { board, api, openBoard } = useBoard();
  useFlowSession();
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const docRef = useRef(board.document);
  docRef.current = board.document;
  const steps = scenario.steps;

  const go = useCallback(
    (i: number) => {
      if (!api || !steps.length) return;
      if (i >= 0 && index < 0) onStart?.();
      const next = Math.max(-1, Math.min(steps.length - 1, i));
      setIndex(next);
      const step = next >= 0 ? steps[next] : undefined;
      const scene = api.getSceneElements();
      api.updateScene({
        elements: highlightStep(docRef.current, step, scene) as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (step) {
        const { frame } = stepTargets(docRef.current, step, api.getSceneElements());
        if (frame.length)
          api.scrollToContent(frame as never, {
            fitToViewport: true,
            viewportZoomFactor: 0.6,
            maxZoom: 1.2,
            animate: true,
            duration: 500,
          });
      }
    },
    [api, steps, index, onStart],
  );

  const resumed = useRef(false);
  /** Steps whose internals flow was already followed (do not go down again when playing on). */
  const visitedBelow = useRef(new Set<number>());
  const cur = index >= 0 ? steps[index] : undefined;
  const frame = flowSession.frameFor(board.id);
  const atEnd = index >= steps.length - 1;
  /** Follow the current step into the flow of its internals board. */
  const descend = useCallback(
    (keepPlaying: boolean) => {
      if (!cur?.drillInto) return;
      flowSession.descend(
        { boardId: board.id, scenarioId: scenario.id, index },
        cur.drillInto,
        keepPlaying,
      );
      openBoard(cur.drillInto.boardId);
    },
    [cur, board.id, scenario.id, index, openBoard],
  );
  /** Back to the board this flow was opened from, at the step after the one that led here. */
  const ascend = useCallback(
    (keepPlaying: boolean) => {
      const to = flowSession.ascend(board.id, keepPlaying);
      if (to) openBoard(to);
    },
    [board.id, openBoard],
  );

  // auto-advance while playing: down into a step's internals flow, on to the next step, and at
  // the end back up to the flow this one was opened from
  useEffect(() => {
    if (!playing) return;
    const wait = index < 0 ? 0 : PLAY_INTERVAL_MS;
    if (cur?.drillInto && !visitedBelow.current.has(index)) {
      const t = setTimeout(() => descend(true), wait);
      return () => clearTimeout(t);
    }
    if (atEnd) {
      if (!frame) {
        setPlaying(false);
        return;
      }
      const t = setTimeout(() => ascend(true), wait);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => go(index + 1), wait);
    return () => clearTimeout(t);
  }, [playing, index, atEnd, cur, frame, go, descend, ascend]);

  // arriving from another board: show the step the session asks for, once the canvas is up
  useEffect(() => {
    if (!resume || resumed.current || !api || !steps.length) return;
    resumed.current = true;
    const t = setTimeout(() => {
      // coming back up: the step that led down is done; continue with the one after it
      const last = steps.length - 1;
      const target = resume.after ? Math.min(resume.index + 1, last) : Math.min(resume.index, last);
      if (resume.after) visitedBelow.current.add(resume.index);
      const finished = resume.after && resume.index >= last;
      onStart?.();
      go(target);
      setPlaying(resume.playing && !finished);
      flowSession.consume(board.id);
    }, 250);
    return () => clearTimeout(t);
    // `go` changes with every step; this runs once per arrival
  }, [resume, api, steps.length, board.id]);

  // restore strokes when the player goes away or the scenario changes
  useEffect(() => {
    if (!resume) {
      setIndex(-1);
      setPlaying(false);
    }
    return () => {
      if (!api) return;
      const scene = api.getSceneElements();
      if (scene.some((e) => (e.customData as { atlasHl?: unknown } | undefined)?.atlasHl))
        api.updateScene({
          elements: clearHighlight(scene) as never,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
    };
  }, [api, scenario.id]);

  return (
    <div className="player" aria-label="Scenario player">
      <div className="player-controls">
        <button type="button" onClick={() => go(index - 1)} disabled={index <= 0}>
          ‹ Prev
        </button>
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          disabled={!steps.length}
          aria-pressed={playing}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => go(index + 1)}
          disabled={!steps.length || index >= steps.length - 1}
        >
          Next ›
        </button>
        {index >= 0 && (
          <button type="button" onClick={() => go(-1)}>
            Reset
          </button>
        )}
      </div>
      {(cur?.drillInto || frame) && (
        <div className="player-controls player-levels">
          {cur?.drillInto && (
            <button
              type="button"
              onClick={() => descend(false)}
              title="Play this step on the board of the component it passes through"
            >
              ↓ Into this step
            </button>
          )}
          {frame && (
            <button
              type="button"
              onClick={() => ascend(false)}
              title="Back to the board this flow was opened from, at the next step"
            >
              ↑ Back to the flow above
            </button>
          )}
        </div>
      )}
      <p className="player-text" aria-live="polite">
        {cur
          ? `Step ${index + 1} / ${steps.length}: ${cur.text || '(no text)'}`
          : steps.length
            ? `${steps.length} step(s). Press Next or Play.`
            : 'No steps yet.'}
      </p>
    </div>
  );
}
