import type { BoardDocument, Scenario } from '@atlas/schema';
import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { elementsOf } from './context.ts';
import { atlasTag } from './materialize.ts';

export { connectionTitle, scenarioToMermaid } from '@atlas/export';

/**
 * Scenario overlays on the canvas (D03 wave 1b). The scenario itself lives in
 * `document.scenarios`; showing one draws circled step numbers as `scenario-step` tagged elements
 * and dims everything off its path, and the player highlights one hop at a time. Every change made
 * to an existing element remembers the original value in `customData` (`atlasDim` for opacity,
 * `atlasHl` for stroke), so hiding restores exactly what was there and a board reloaded while a
 * scenario was shown can be cleaned (`clearDecorations`).
 */
type El = ExcalidrawElement;
type Custom = { atlasDim?: number; atlasHl?: { strokeColor: string; strokeWidth: number } };
const custom = (e: El) => (e.customData ?? {}) as Custom & Record<string, unknown>;

export const STEP_COLOR = '#e11d48';
const DIM_OPACITY = 18;
const STEP_SIZE = 30;

export const isStepElement = (e: { customData?: unknown }) => atlasTag(e)?.kind === 'scenario-step';

/** Scenario whose step numbers are on the canvas, if any. */
export function shownScenarioId(elements: readonly El[]): string | undefined {
  for (const e of elements)
    if (!e.isDeleted && isStepElement(e))
      return (custom(e).atlas as { scenarioId?: string } | undefined)?.scenarioId;
  return undefined;
}

const withoutKey = (c: Record<string, unknown>, key: string) => {
  const { [key]: _drop, ...rest } = c;
  return Object.keys(rest).length ? rest : undefined;
};

/** Undo the player highlight (stroke) only. */
export function clearHighlight(elements: readonly El[]): El[] {
  return elements.map((e) => {
    const hl = custom(e).atlasHl;
    if (!hl) return e;
    return newElementWith(e, {
      strokeColor: hl.strokeColor,
      strokeWidth: hl.strokeWidth,
      customData: withoutKey(custom(e), 'atlasHl'),
    });
  });
}

/** Remove step numbers and restore dimmed/highlighted elements. */
export function clearDecorations(elements: readonly El[]): El[] {
  return clearHighlight(elements)
    .filter((e) => !isStepElement(e))
    .map((e) => {
      const dim = custom(e).atlasDim;
      if (dim === undefined) return e;
      return newElementWith(e, { opacity: dim, customData: withoutKey(custom(e), 'atlasDim') });
    });
}

export const hasDecorations = (elements: readonly { customData?: unknown }[]) =>
  elements.some((e) => {
    const c = (e.customData ?? {}) as Custom;
    return isStepElement(e) || c.atlasDim !== undefined || c.atlasHl !== undefined;
  });

/**
 * Point at fraction t of an arrow's polyline, in scene coordinates, with the unit normal of that
 * segment that points up (or left on vertical segments), to sit a marker beside the line.
 */
function pointAlong(a: El & { points?: readonly (readonly [number, number])[] }, t: number) {
  const pts = a.points?.length ? a.points : [[0, 0] as const];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    seg.push(d);
    total += d;
  }
  let want = total * t;
  for (let i = 1; i < pts.length; i++) {
    const d = seg[i - 1]!;
    if (want <= d || i === pts.length - 1) {
      const f = d ? Math.min(1, want / d) : 0;
      const dx = d ? (pts[i]![0] - pts[i - 1]![0]) / d : 1;
      const dy = d ? (pts[i]![1] - pts[i - 1]![1]) / d : 0;
      // normal (-dy, dx) or its opposite, whichever points up / left
      const flip = dx > 0 || (dx === 0 && dy < 0) ? 1 : -1;
      return {
        x: a.x + pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * f,
        y: a.y + pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * f,
        nx: dy * flip,
        ny: -dx * flip,
      };
    }
    want -= d;
  }
  return { x: a.x + pts[0]![0], y: a.y + pts[0]![1], nx: 0, ny: -1 };
}

/** Elements on a scenario's path: its hops' arrows and both ends, and component-only steps. */
function pathOf(doc: BoardDocument, scenario: Scenario, elements: readonly El[]): Set<string> {
  const ids = new Set<string>();
  const add = (kind: 'component' | 'connection', id: string | undefined) => {
    if (id) for (const e of elementsOf(elements, { kind, id })) ids.add(e.id);
  };
  for (const s of scenario.steps) {
    const k = s.connectionId ? doc.connections[s.connectionId] : undefined;
    if (k) {
      add('connection', k.id);
      add('component', k.from);
      add('component', k.to);
    } else add('component', s.componentId);
  }
  return ids;
}

/** Elements a step points at (for highlight and camera), shapes first. */
export function stepTargets(
  doc: BoardDocument,
  step: Scenario['steps'][number],
  elements: readonly El[],
): { hop: El[]; frame: El[] } {
  const k = step.connectionId ? doc.connections[step.connectionId] : undefined;
  if (k) {
    const hop = elementsOf(elements, { kind: 'connection', id: k.id }) as El[];
    const ends = [
      ...elementsOf(elements, { kind: 'component', id: k.from }),
      ...elementsOf(elements, { kind: 'component', id: k.to }),
    ] as El[];
    return { hop, frame: [...hop, ...ends] };
  }
  const comp = step.componentId
    ? (elementsOf(elements, { kind: 'component', id: step.componentId }) as El[])
    : [];
  return { hop: comp, frame: comp };
}

/**
 * The scene with one scenario shown: previous decorations cleared, a circled number per step next
 * to its arrow (a quarter of the way along, clear of the arrow's label) or at its box's corner, and
 * everything off the path dimmed.
 */
export function showScenario(doc: BoardDocument, scenario: Scenario, scene: readonly El[]): El[] {
  const base = clearDecorations(scene);
  const live = base.filter((e) => !e.isDeleted);
  const onPath = pathOf(doc, scenario, live);
  const used = new Map<string, number>();
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
  /** circle element id -> [step id, centre] */
  const marks = new Map<string, { stepId: string; cx: number; cy: number }>();
  scenario.steps.forEach((s, i) => {
    const { hop } = stepTargets(doc, s, live);
    const shape = hop.find((e) => e.type === 'arrow') ?? hop.find((e) => e.type !== 'text');
    if (!shape) return;
    const n = used.get(shape.id) ?? 0;
    used.set(shape.id, n + 1);
    let at: { x: number; y: number };
    if (shape.type === 'arrow') {
      // beside the line, a third of the way along (the arrow's own label sits at the middle)
      const p = pointAlong(shape as never, 0.3 + 0.2 * Math.min(n, 2));
      const off = STEP_SIZE / 2 + 6;
      at = { x: p.x + p.nx * off, y: p.y + p.ny * off };
    } else at = { x: shape.x + n * (STEP_SIZE + 4), y: shape.y };
    // a round badge and its number, grouped (a bound label would stretch the circle to fit it)
    const id = `stp-${scenario.id}-${s.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
    marks.set(id, { stepId: s.id, cx: at.x, cy: at.y });
    marks.set(`${id}-n`, { stepId: s.id, cx: at.x, cy: at.y });
    const common = { groupIds: [`${id}-g`], roughness: 0, strokeWidth: 1 };
    skeletons.push(
      {
        type: 'ellipse',
        id,
        x: at.x - STEP_SIZE / 2,
        y: at.y - STEP_SIZE / 2,
        width: STEP_SIZE,
        height: STEP_SIZE,
        strokeColor: STEP_COLOR,
        backgroundColor: STEP_COLOR,
        fillStyle: 'solid',
        ...common,
      },
      {
        type: 'text',
        id: `${id}-n`,
        x: at.x,
        y: at.y,
        text: String(i + 1),
        fontSize: 16,
        textAlign: 'center',
        verticalAlign: 'middle',
        strokeColor: '#ffffff',
        ...common,
      },
    );
  });
  const steps = convertToExcalidrawElements(skeletons, { regenerateIds: false }).map((e) => {
    const m = marks.get(e.id);
    // centre the number on its badge now that its size is measured
    const pos = e.type === 'text' && m ? { x: m.cx - e.width / 2, y: m.cy - e.height / 2 } : {};
    return {
      ...e,
      ...pos,
      locked: true,
      customData: {
        atlas: { kind: 'scenario-step', id: m?.stepId ?? '', scenarioId: scenario.id },
      },
    } as El;
  });
  const dimmed = base.map((e) => {
    if (e.isDeleted || onPath.has(e.id) || e.type === 'frame') return e;
    if (e.opacity <= DIM_OPACITY) return e;
    return newElementWith(e, {
      opacity: DIM_OPACITY,
      customData: { ...custom(e), atlasDim: e.opacity },
    });
  });
  return [...dimmed, ...steps];
}

/** Highlight one step's hop (thicker, coloured stroke); the previous highlight is restored first. */
export function highlightStep(
  doc: BoardDocument,
  step: Scenario['steps'][number] | undefined,
  scene: readonly El[],
): El[] {
  const base = clearHighlight(scene);
  if (!step) return base;
  const hop = new Set(
    stepTargets(doc, step, base)
      .hop.filter((e) => e.type !== 'text')
      .map((e) => e.id),
  );
  return base.map((e) =>
    hop.has(e.id)
      ? newElementWith(e, {
          strokeColor: STEP_COLOR,
          strokeWidth: Math.max(4, e.strokeWidth + 2),
          customData: {
            ...custom(e),
            atlasHl: { strokeColor: e.strokeColor, strokeWidth: e.strokeWidth },
          },
        })
      : e,
  );
}

/** Short local ids for new scenarios, steps and doc items. */
export const newLocalId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
