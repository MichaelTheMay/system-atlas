import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scenario } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { useBoard } from './context.ts';
import { clearHighlight, highlightStep, stepTargets } from './scenarios.ts';

const PLAY_INTERVAL_MS = 1500;

/**
 * Step-through player for a scenario (D03 wave 1b): highlights the current hop (thicker, coloured
 * stroke), shows the step's text and moves the camera to it. Leaving (or switching scenario)
 * restores the original strokes. `onStart` lets the caller make sure the scenario is shown.
 */
export function Player({ scenario, onStart }: { scenario: Scenario; onStart?: () => void }) {
  const { board, api } = useBoard();
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

  // auto-advance while playing; stop at the last step
  useEffect(() => {
    if (!playing) return;
    if (index >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => go(index + 1), index < 0 ? 0 : PLAY_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [playing, index, steps.length, go]);

  // restore strokes when the player goes away or the scenario changes
  useEffect(() => {
    setIndex(-1);
    setPlaying(false);
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

  const cur = index >= 0 ? steps[index] : undefined;
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
