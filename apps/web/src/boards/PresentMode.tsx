import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { elementsOf, useBoard } from './context.ts';
import { atlasTag } from './materialize.ts';
import { Player } from './Player.tsx';
import { clearDecorations, showScenario, shownScenarioId } from './scenarios.ts';

type SceneEl = ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number];
interface Slide {
  label: string;
  targets: readonly SceneEl[];
}

/**
 * Presentation of a board (D03 wave 1b): read-only (Excalidraw view mode) and full-screen, frames
 * as slides in creation order (← → / PageUp PageDown / space), the camera animating to each one;
 * a laser pointer; and a scenario reveal whose steps advance with the player. Esc exits.
 *
 * Laser: Excalidraw 0.18 pans on every drag in view mode, so its laser tool cannot draw there.
 * While the laser is on, the canvas leaves view mode for zen mode (no toolbars) with the laser
 * tool active, and this component swallows every key but navigation, so it stays read-only.
 *
 * Slides: the board's frames (`document.frames`, in order) drawn as an Excalidraw frame when the
 * materializer drew one, otherwise the frame's components; then frames people drew by hand; with
 * no frames at all, one slide with the whole board.
 */
export function PresentMode({
  onExit,
  laser,
  onLaser,
}: {
  onExit: () => void;
  laser: boolean;
  onLaser: (on: boolean) => void;
}) {
  const { board, api } = useBoard();
  const doc = board.document;
  const [index, setIndex] = useState(0);
  // a scenario shown in the side panel carries over into the presentation
  const [scenarioId, setScenarioId] = useState(() =>
    api ? (shownScenarioId(api.getSceneElements()) ?? '') : '',
  );
  const entered = useRef(false);
  const first = useRef(true);

  const slides = useMemo<Slide[]>(() => {
    if (!api) return [];
    const els = api.getSceneElements();
    const out: Slide[] = [];
    const usedFrames = new Set<string>();
    for (const f of doc.frames) {
      const frameEl = els.find(
        (e) =>
          e.type === 'frame' &&
          (e.id === f.elementId || (atlasTag(e)?.kind === 'frame' && atlasTag(e)?.id === f.id)),
      );
      if (frameEl) usedFrames.add(frameEl.id);
      const targets = frameEl
        ? [frameEl]
        : f.componentIds.flatMap((id) => elementsOf(els, { kind: 'component', id }) as SceneEl[]);
      if (targets.length) out.push({ label: f.label, targets });
    }
    for (const e of els)
      if ((e.type === 'frame' || e.type === 'magicframe') && !usedFrames.has(e.id))
        out.push({ label: (e as { name?: string | null }).name || 'Frame', targets: [e] });
    if (!out.length) out.push({ label: board.name, targets: els });
    return out;
  }, [api, doc.frames, board.name]);

  const exit = useCallback(() => {
    if (api) {
      const scene = api.getSceneElements();
      api.setActiveTool({ type: 'selection' });
      api.updateScene({
        elements: clearDecorations(scene) as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onExit();
  }, [api, onExit]);

  // full screen when the browser allows it (the CSS overlay covers the window either way)
  useEffect(() => {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement)
      el.requestFullscreen()
        .then(() => (entered.current = true))
        .catch(() => undefined);
    const onFs = () => {
      // leaving browser full screen (its own Esc) ends the presentation too
      if (entered.current && !document.fullscreenElement) exit();
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [exit]);

  // camera to the current slide
  useEffect(() => {
    const s = slides[index];
    if (!api || !s) return;
    // on entry the canvas is still growing to full screen: let it settle before measuring
    const delay = first.current ? 250 : 0;
    first.current = false;
    const t = setTimeout(() => {
      api.refresh();
      api.scrollToContent(s.targets as never, {
        fitToViewport: true,
        viewportZoomFactor: 0.85,
        maxZoom: 1.5,
        animate: true,
        duration: 600,
      });
    }, delay);
    return () => clearTimeout(t);
  }, [api, slides, index]);

  const go = useCallback(
    (d: number) => setIndex((i) => Math.max(0, Math.min(slides.length - 1, i + d))),
    [slides.length],
  );

  // keys win over Excalidraw's own shortcuts while presenting
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const k = e.key;
      if (t?.tagName === 'SELECT' || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') {
        if (k !== 'Escape') return;
      } else if (t?.tagName === 'BUTTON' && (k === ' ' || k === 'Enter')) return;
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') go(1);
      else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
      else if (k === 'Escape') exit();
      else if (k === 'Tab') return;
      // every other key is swallowed: no editing shortcuts reach the canvas while presenting
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [go, exit]);

  // the laser tool needs Excalidraw out of view mode (BoardView swaps to zen mode meanwhile)
  useEffect(() => {
    if (!api) return;
    const t = setTimeout(() => api.setActiveTool({ type: laser ? 'laser' : 'selection' }), 0);
    return () => clearTimeout(t);
  }, [api, laser]);
  const toggleLaser = () => onLaser(!laser);

  const scenario = doc.scenarios.find((s) => s.id === scenarioId);
  const reveal = (id: string) => {
    setScenarioId(id);
    if (!api) return;
    const s = doc.scenarios.find((x) => x.id === id);
    const scene = api.getSceneElements();
    api.updateScene({
      elements: (s ? showScenario(doc, s, scene) : clearDecorations(scene)) as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  const slide = slides[index];
  return (
    <div className="present-bar" role="toolbar" aria-label="Presentation">
      <button
        type="button"
        aria-label="Previous slide"
        onClick={() => go(-1)}
        disabled={index <= 0}
      >
        ‹
      </button>
      <span className="present-slide" aria-live="polite">
        Slide {index + 1} / {slides.length}
        {slide ? ` · ${slide.label}` : ''}
      </span>
      <button
        type="button"
        aria-label="Next slide"
        onClick={() => go(1)}
        disabled={index >= slides.length - 1}
      >
        ›
      </button>
      <button type="button" aria-pressed={laser} onClick={toggleLaser}>
        Laser
      </button>
      <select
        aria-label="Reveal scenario"
        value={scenarioId}
        onChange={(e) => reveal(e.target.value)}
      >
        <option value="">No scenario</option>
        {doc.scenarios
          .filter((s) => s.status !== 'rejected')
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
      </select>
      {scenario && <Player scenario={scenario} />}
      <button type="button" onClick={exit}>
        Exit (Esc)
      </button>
    </div>
  );
}
