import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ProjectionDto, ProjectionNodeDto } from '../../api.ts';
import { archetypeLabel, isDesignLens } from './archetypes.tsx';
import { subsystemPathOf } from './DesignInspector.tsx';
import {
  DesignApiError,
  designApi,
  drawnSubsystemCanvasId,
  type Archetype,
  type DesignApi,
  type DesignBody,
  type DesignElementDto,
  type FlowEnd,
} from './designApi.ts';

/**
 * Whiteboard edits of the System design canvases (D02a): one place that talks to the design-element
 * API, keeps the project's elements, and records every operation the person makes as an undoable
 * step. Elements are view data (never facts): deleting a detected box only hides it, grouping
 * detected boxes writes human subsystem claims through the validator.
 *
 * Undo/redo replays the inverse API calls. A recreated element gets a new id, so the stack keeps an
 * old -> new id map and every replayed body is rewritten through it. Revisions always come from a
 * fresh element list, never from the stack.
 */

interface Step {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface DesignMessage {
  text: string;
  tone: 'info' | 'warn' | 'error';
  /** Offer an Undo button (hide, delete). */
  undoable?: boolean;
}

export interface DesignEdits {
  /** Edits are possible: design root, latest snapshot, project known. */
  enabled: boolean;
  editMode: boolean;
  setEditMode(on: boolean): void;
  projection: ProjectionDto | null;
  elements: DesignElementDto[];
  element(id: string | undefined): DesignElementDto | undefined;
  /** Drawn subsystem this canvas shows, when it is a drawn-subsystem canvas. */
  canvasElementId?: string;
  /** Drawn boxes show on the root and on drawn subsystem canvases only. */
  canDrawBoxes: boolean;
  busy: boolean;
  message: DesignMessage | null;
  dismiss(): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Node id being renamed inline, or a drawn flow's element id whose label is being edited. */
  renaming: string | null;
  setRenaming(id: string | null): void;
  selectedNodes: ProjectionNodeDto[];
  setSelectedNodes(ns: ProjectionNodeDto[]): void;
  addBox(archetype: Archetype): Promise<string | undefined>;
  addSubsystem(): Promise<string | undefined>;
  addSticky(): Promise<string | undefined>;
  rename(node: ProjectionNodeDto, label: string): Promise<void>;
  setArchetype(node: ProjectionNodeDto, archetype: Archetype): Promise<void>;
  setStickyText(elementId: string, text: string): Promise<void>;
  connect(from: ProjectionNodeDto, to: ProjectionNodeDto): Promise<void>;
  setFlowLabel(elementId: string, label: string): Promise<void>;
  adopt(fromEntityId: string, toEntityId: string, label?: string): Promise<void>;
  group(nodes: ProjectionNodeDto[], name: string): Promise<void>;
  /** Move boxes into a drawn subsystem (`parentId`) or to the top level (`undefined`). */
  moveTo(nodes: ProjectionNodeDto[], parentId: string | undefined): Promise<void>;
  /** Drawn elements are deleted; detected boxes are hidden (suppress override). */
  remove(nodes: ProjectionNodeDto[]): Promise<void>;
  /** Delete drawn flows (by element id). */
  removeFlows(flows: { elementId: string; label: string }[]): Promise<void>;
  accept(elementId: string): Promise<void>;
  reject(elementId: string): Promise<void>;
  /** Drawn subsystems a box can move into (accepted ones). */
  subsystems: DesignElementDto[];
  /** Re-project the board (after a new node's position was saved). */
  refresh(): void;
}

const Ctx = createContext<DesignEdits | null>(null);

export function useDesignEdits(): DesignEdits | null {
  return useContext(Ctx);
}

/** A detected box (or claim subsystem) is a code box: it has an anchor entity and no drawn element. */
export const isDrawn = (n: ProjectionNodeDto) => n.id.startsWith('design:');
export const isSticky = (n: ProjectionNodeDto) => n.kind === 'sticky';
export const isDetectedBox = (n: ProjectionNodeDto) =>
  n.id.startsWith('box:') && !!n.entityId && n.kind !== 'port';

export function DesignEditsProvider({
  token,
  projectId,
  snapshotId,
  historical,
  projection,
  reloadKey,
  onChanged,
  children,
}: {
  token: string | null;
  projectId?: string;
  /** Latest snapshot (grouping writes claims against it). */
  snapshotId?: string;
  historical: boolean;
  /** Projection on screen when the design root is shown; null otherwise. */
  projection: ProjectionDto | null;
  /** Moves whenever the board may have changed (design.changed, rescans). */
  reloadKey: number;
  /** Re-plan and re-project now (the SSE event does the same; this is the fallback). */
  onChanged(): void;
  children: ReactNode;
}) {
  const [editMode, setEditModeState] = useState(false);
  const [elements, setElements] = useState<DesignElementDto[]>([]);
  const [canvasToElement, setCanvasToElement] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<DesignMessage | null>(null);
  const [undoStack, setUndoStack] = useState<Step[]>([]);
  const [redoStack, setRedoStack] = useState<Step[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<ProjectionNodeDto[]>([]);
  const remap = useRef(new Map<string, string>());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const design = projection && isDesignLens(projection.lens) ? projection : null;
  const enabled = !!(token && projectId && snapshotId && design && !historical);
  const api: DesignApi | null = useMemo(
    () => (token && projectId ? designApi(token, projectId) : null),
    [token, projectId],
  );

  // a different project starts with an empty stack (ids would point at another board)
  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    remap.current.clear();
    setElements([]);
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!api) return [];
    const els = await api.list();
    setElements(els);
    return els;
  }, [api]);

  useEffect(() => {
    reload().catch(() => setElements([]));
  }, [reload, reloadKey]);

  // which canvas each accepted drawn subsystem opens (mirrors the planner's canvas ids)
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const subs = elements.filter((e) => e.body.kind === 'subsystem' && e.status === 'active');
    Promise.all(subs.map(async (e) => [await drawnSubsystemCanvasId(projectId, e.id), e.id]))
      .then((pairs) => {
        if (!cancelled) setCanvasToElement(new Map(pairs as [string, string][]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [elements, projectId]);

  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);
  const canvasElementId = design ? canvasToElement.get(design.canvasId) : undefined;
  const isRoot = design?.lens === 'design-system';
  const canDrawBoxes = !!design && (isRoot || !!canvasElementId);

  /** Current id of an element (it changes when undo/redo recreates it). */
  const resolve = useCallback((id: string) => {
    let cur = id;
    const seen = new Set<string>();
    while (remap.current.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = remap.current.get(cur)!;
    }
    return cur;
  }, []);
  const rebody = useCallback(
    (b: DesignBody): DesignBody => {
      const end = (e: FlowEnd): FlowEnd =>
        'elementId' in e ? { elementId: resolve(e.elementId) } : e;
      if (b.kind === 'flow') return { ...b, from: end(b.from), to: end(b.to) };
      if ((b.kind === 'box' || b.kind === 'subsystem') && b.parentId)
        return { ...b, parentId: resolve(b.parentId) };
      return b;
    },
    [resolve],
  );

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DesignApiError && e.status === 409) {
        setMessage({
          text: 'This element was changed elsewhere since the board loaded. The board was refreshed: check it and try again.',
          tone: 'warn',
        });
        void reload().catch(() => undefined);
        onChangedRef.current();
      } else {
        setMessage({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
      }
    },
    [reload],
  );

  /** Run an operation; a Step is pushed on the undo stack (and the redo stack cleared). */
  const run = useCallback(
    async (fn: () => Promise<Step | null | undefined>, after?: DesignMessage) => {
      if (!api) return;
      setBusy(true);
      try {
        const step = await fn();
        if (step) {
          setUndoStack((s) => [...s.slice(-99), step]);
          setRedoStack([]);
        }
        setMessage(after ?? null);
        await reload();
        onChangedRef.current();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [api, fail, reload],
  );

  // ---- step builders: each performs the operation and returns its inverse --------------------

  const revOf = useCallback(
    async (id: string) => {
      const els = await reload();
      const e = els.find((x) => x.id === resolve(id));
      if (!e) throw new Error('That element no longer exists on the board.');
      return e;
    },
    [reload, resolve],
  );

  const createStep = useCallback(
    async (label: string, body: DesignBody, bound: string[] = []) => {
      const created = await api!.create(body, bound);
      const orig = created.id;
      const step: Step & { id: string } = {
        id: orig,
        label,
        undo: async () => {
          const e = await revOf(orig);
          await api!.remove(e.id, e.revision);
        },
        redo: async () => {
          const again = await api!.create(rebody(body), bound);
          remap.current.set(orig, again.id);
        },
      };
      return step;
    },
    [api, rebody, revOf],
  );

  const patchStep = useCallback(
    async (label: string, id: string, next: { body?: DesignBody; boundEntityIds?: string[] }) => {
      const before = await revOf(id);
      await api!.patch(before.id, before.revision, next);
      const prev = { body: before.body, boundEntityIds: before.boundEntityIds };
      const step: Step = {
        label,
        undo: async () => {
          const e = await revOf(id);
          await api!.patch(e.id, e.revision, {
            body: rebody(prev.body),
            boundEntityIds: prev.boundEntityIds,
          });
        },
        redo: async () => {
          const e = await revOf(id);
          await api!.patch(e.id, e.revision, {
            ...(next.body ? { body: rebody(next.body) } : {}),
            ...(next.boundEntityIds ? { boundEntityIds: next.boundEntityIds } : {}),
          });
        },
      };
      return step;
    },
    [api, rebody, revOf],
  );

  /** Delete a person's element; undo recreates it with the flows that went with it and its children. */
  const deleteStep = useCallback(
    async (label: string, id: string): Promise<Step | null> => {
      const target = await revOf(id);
      const snapshot = new Map(elements.map((e) => [e.id, e]));
      const out = await api!.remove(target.id, target.revision);
      if (target.author === 'agent') return null; // agent work is rejected (audited), not undoable
      const orig = id;
      const flows = out.deleted
        .filter((x) => x !== target.id)
        .map((x) => snapshot.get(x))
        .filter((e): e is DesignElementDto => !!e && e.body.kind === 'flow');
      const children = out.reparented;
      const restore = async () => {
        const again = await api!.create(rebody(target.body), target.boundEntityIds);
        remap.current.set(orig, again.id);
        for (const f of flows) {
          const nf = await api!.create(rebody(f.body), f.boundEntityIds);
          remap.current.set(f.id, nf.id);
        }
        if (target.body.kind === 'subsystem')
          for (const c of children) {
            const e = await revOf(c);
            if (e.body.kind === 'box' || e.body.kind === 'subsystem')
              await api!.patch(e.id, e.revision, { body: { ...e.body, parentId: again.id } });
          }
      };
      return {
        label,
        undo: restore,
        redo: async () => {
          const e = await revOf(orig);
          await api!.remove(e.id, e.revision);
        },
      };
    },
    [api, elements, rebody, revOf],
  );

  const hideStep = useCallback(
    async (label: string, entityId: string): Promise<Step> => {
      await api!.hide(entityId, true);
      return {
        label,
        undo: async () => void (await api!.hide(entityId, false)),
        redo: async () => void (await api!.hide(entityId, true)),
      };
    },
    [api],
  );

  const compound = (label: string, steps: Step[]): Step => ({
    label,
    undo: async () => {
      for (const s of [...steps].reverse()) await s.undo();
    },
    redo: async () => {
      for (const s of steps) await s.redo();
    },
  });

  /** The accepted box element that decorates (relabels) a detected box, if any. */
  const decoratorOf = useCallback(
    (entityId: string) =>
      elements.find(
        (e) =>
          e.body.kind === 'box' &&
          e.status === 'active' &&
          e.boundEntityIds.length === 1 &&
          e.boundEntityIds[0] === entityId,
      ),
    [elements],
  );

  /** Where new boxes go: the drawn subsystem this canvas shows, else the top level. */
  const parentHere = canvasElementId;

  // ---- actions ---------------------------------------------------------------------------------

  const addBox = useCallback(
    async (archetype: Archetype) => {
      let nodeId: string | undefined;
      await run(async () => {
        const s = await createStep(`add ${archetype} box`, {
          kind: 'box',
          label: `New ${archetypeLabel(archetype)}`,
          archetype,
          ...(parentHere ? { parentId: parentHere } : {}),
        });
        nodeId = `design:${s.id}`;
        return s;
      });
      return nodeId;
    },
    [run, createStep, parentHere],
  );

  const addSubsystem = useCallback(async () => {
    let nodeId: string | undefined;
    await run(async () => {
      const s = await createStep('add subsystem', {
        kind: 'subsystem',
        label: 'New subsystem',
        ...(parentHere ? { parentId: parentHere } : {}),
      });
      nodeId = `design:${s.id}`;
      return s;
    });
    return nodeId;
  }, [run, createStep, parentHere]);

  const addSticky = useCallback(async () => {
    if (!design) return undefined;
    let nodeId: string | undefined;
    await run(async () => {
      const s = await createStep('add sticky note', {
        kind: 'sticky',
        text: 'Note',
        canvasId: design.canvasId,
      });
      nodeId = `sticky:${s.id}`;
      return s;
    });
    return nodeId;
  }, [run, createStep, design]);

  const rename = useCallback(
    (node: ProjectionNodeDto, label: string) =>
      run(async () => {
        const text = label.trim().slice(0, 120);
        if (!text || text === node.label) return null;
        const el = node.designElementId ? byId.get(node.designElementId) : undefined;
        if (el && (el.body.kind === 'box' || el.body.kind === 'subsystem'))
          return patchStep(`rename to ${text}`, el.id, { body: { ...el.body, label: text } });
        if (isDetectedBox(node)) {
          // a detected box is relabelled by a box element bound to its entity
          const d = decoratorOf(node.entityId!);
          if (d && d.body.kind === 'box')
            return patchStep(`rename to ${text}`, d.id, { body: { ...d.body, label: text } });
          return createStep(
            `rename to ${text}`,
            {
              kind: 'box',
              label: text,
              archetype: (node.archetype ?? 'service') as Archetype,
            },
            [node.entityId!],
          );
        }
        throw new Error('Only drawn boxes, drawn subsystems and detected boxes can be renamed.');
      }),
    [run, byId, patchStep, createStep, decoratorOf],
  );

  const setArchetype = useCallback(
    (node: ProjectionNodeDto, archetype: Archetype) =>
      run(async () => {
        if (archetype === node.archetype) return null;
        const el = node.designElementId ? byId.get(node.designElementId) : undefined;
        if (el && el.body.kind === 'box')
          return patchStep(`make ${archetype}`, el.id, { body: { ...el.body, archetype } });
        if (isDetectedBox(node)) {
          const d = decoratorOf(node.entityId!);
          if (d && d.body.kind === 'box')
            return patchStep(`make ${archetype}`, d.id, { body: { ...d.body, archetype } });
          return createStep(`make ${archetype}`, { kind: 'box', label: node.label, archetype }, [
            node.entityId!,
          ]);
        }
        throw new Error('Only boxes have an archetype.');
      }),
    [run, byId, patchStep, createStep, decoratorOf],
  );

  const setStickyText = useCallback(
    (elementId: string, text: string) =>
      run(async () => {
        const el = byId.get(elementId);
        if (!el || el.body.kind !== 'sticky' || el.body.text === text) return null;
        return patchStep('edit note', el.id, { body: { ...el.body, text: text.slice(0, 2000) } });
      }),
    [run, byId, patchStep],
  );

  const endOf = (n: ProjectionNodeDto): FlowEnd | undefined =>
    isDrawn(n) && n.designElementId
      ? { elementId: n.designElementId }
      : n.entityId
        ? { entityId: n.entityId }
        : undefined;

  const connect = useCallback(
    (from: ProjectionNodeDto, to: ProjectionNodeDto) =>
      run(async () => {
        const a = endOf(from);
        const b = endOf(to);
        if (!a || !b || from.id === to.id)
          throw new Error('A flow connects two different boxes or subsystems.');
        if (from.ghost || to.ghost) throw new Error('Accept the proposed box first.');
        const s = await createStep(`connect ${from.label} → ${to.label}`, {
          kind: 'flow',
          from: a,
          to: b,
        });
        // the new flow opens with its label being edited
        setRenaming(`flow:${s.id}`);
        return s;
      }),
    [run, createStep],
  );

  const setFlowLabel = useCallback(
    (elementId: string, label: string) =>
      run(async () => {
        const el = byId.get(elementId);
        const text = label.trim().slice(0, 60);
        if (!el || el.body.kind !== 'flow' || (el.body.label ?? '') === text) return null;
        const body = { ...el.body };
        if (text) body.label = text;
        else delete body.label;
        return patchStep(`label flow ${text}`, el.id, { body });
      }),
    [run, byId, patchStep],
  );

  const adopt = useCallback(
    (fromEntityId: string, toEntityId: string, label?: string) =>
      run(async () =>
        createStep(`adopt ${label ?? 'flow'}`, {
          kind: 'flow',
          from: { entityId: fromEntityId },
          to: { entityId: toEntityId },
          ...(label ? { label: label.slice(0, 60) } : {}),
        }),
      ),
    [run, createStep],
  );

  const moveSteps = useCallback(
    async (nodes: ProjectionNodeDto[], parentId: string | undefined) => {
      const steps: Step[] = [];
      for (const n of nodes) {
        const el = n.designElementId ? byId.get(n.designElementId) : undefined;
        const withParent = <T extends { parentId?: string }>(b: T): T => {
          const next = { ...b };
          if (parentId) next.parentId = parentId;
          else delete next.parentId;
          return next;
        };
        if (el && (el.body.kind === 'box' || el.body.kind === 'subsystem')) {
          if (el.id === parentId || (el.body.parentId ?? undefined) === parentId) continue;
          steps.push(await patchStep(`move ${n.label}`, el.id, { body: withParent(el.body) }));
        } else if (isDetectedBox(n)) {
          const d = decoratorOf(n.entityId!);
          if (d && d.body.kind === 'box') {
            if ((d.body.parentId ?? undefined) === parentId) continue;
            steps.push(await patchStep(`move ${n.label}`, d.id, { body: withParent(d.body) }));
          } else if (parentId) {
            steps.push(
              await createStep(
                `move ${n.label}`,
                {
                  kind: 'box',
                  label: n.label,
                  archetype: (n.archetype ?? 'service') as Archetype,
                  parentId,
                },
                [n.entityId!],
              ),
            );
          }
        }
      }
      return steps;
    },
    [byId, patchStep, createStep, decoratorOf],
  );

  const moveTo = useCallback(
    (nodes: ProjectionNodeDto[], parentId: string | undefined) =>
      run(async () => {
        const steps = await moveSteps(nodes, parentId);
        if (!steps.length) return null;
        const into = parentId ? byId.get(parentId) : undefined;
        return compound(
          `move ${steps.length} box(es) ${into && 'label' in into.body ? `into ${into.body.label}` : 'out'}`,
          steps,
        );
      }),
    [run, moveSteps, byId],
  );

  const group = useCallback(
    (nodes: ProjectionNodeDto[], name: string) =>
      run(async () => {
        const label = name.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!label) throw new Error('Name the subsystem first.');
        const drawn = nodes.filter((n) => isDrawn(n));
        const detected = nodes.filter(isDetectedBox);
        if (!detected.length && !drawn.length)
          throw new Error('Select boxes on the canvas to group (ports cannot be grouped here).');
        // drawn boxes, or any selection on a drawn subsystem canvas: a drawn subsystem holds them
        if (drawn.length || canvasElementId) {
          const sub = await createStep(`group into ${label}`, {
            kind: 'subsystem',
            label,
            ...(parentHere ? { parentId: parentHere } : {}),
          });
          const moved = await moveSteps([...drawn, ...detected], sub.id);
          return compound(`group into ${label}`, [sub, ...moved]);
        }
        // detected boxes only: a human subsystem claim per box, through the claim validator
        const path = design?.lens === 'design-subsystem' ? subsystemPathOf(design, label) : label;
        const entityIds = detected.map((n) => n.entityId!);
        const r = await api!.group(snapshotId!, path, entityIds);
        if (!r.accepted.length && !r.alreadyGrouped.length)
          throw new Error(
            `The claim validator refused the grouping: ${r.rejected.flatMap((x) => x.reasons).join('; ')}`,
          );
        let claimIds = r.accepted.map((a) => a.claimId);
        return {
          label: `group into ${label}`,
          undo: async () => {
            for (const id of claimIds) await api!.rejectClaim(id, 'undo on the whiteboard');
          },
          redo: async () => {
            const again = await api!.group(snapshotId!, path, entityIds);
            claimIds = again.accepted.map((a) => a.claimId);
          },
        };
      }),
    [run, createStep, moveSteps, canvasElementId, parentHere, design, api, snapshotId],
  );

  const remove = useCallback(
    (nodes: ProjectionNodeDto[]) => {
      const names = nodes.map((n) => n.label).join(', ');
      const hides = nodes.some(isDetectedBox);
      return run(
        async () => {
          const steps: Step[] = [];
          for (const n of nodes) {
            if ((isDrawn(n) || isSticky(n)) && n.designElementId) {
              const s = await deleteStep(`delete ${n.label}`, n.designElementId);
              if (s) steps.push(s);
            } else if (isDetectedBox(n)) {
              steps.push(await hideStep(`hide ${n.label}`, n.entityId!));
            }
          }
          if (!steps.length) return null;
          return steps.length === 1 ? steps[0]! : compound(`remove ${names}`, steps);
        },
        {
          text: hides
            ? `Hid ${names} from the design views. The code facts are kept.`
            : `Deleted ${names}.`,
          tone: 'info',
          undoable: true,
        },
      );
    },
    [run, deleteStep, hideStep],
  );

  const removeFlows = useCallback(
    (flows: { elementId: string; label: string }[]) =>
      run(
        async () => {
          const steps: Step[] = [];
          for (const f of flows) {
            const st = await deleteStep(`delete ${f.label} flow`, f.elementId);
            if (st) steps.push(st);
          }
          if (!steps.length) return null;
          return steps.length === 1 ? steps[0]! : compound('delete flows', steps);
        },
        {
          text: `Deleted the drawn flow${flows.length > 1 ? 's' : ''}.`,
          tone: 'info',
          undoable: true,
        },
      ),
    [run, deleteStep],
  );

  const accept = useCallback(
    (elementId: string) =>
      run(
        async () => {
          const e = await revOf(elementId);
          await api!.accept(e.id, e.revision);
          return null;
        },
        { text: 'Accepted: the proposal is now part of your board.', tone: 'info' },
      ),
    [run, revOf, api],
  );

  const reject = useCallback(
    (elementId: string) =>
      run(
        async () => {
          const e = await revOf(elementId);
          await api!.remove(e.id, e.revision);
          return null;
        },
        { text: 'Rejected: the proposal is kept in the audit trail only.', tone: 'info' },
      ),
    [run, revOf, api],
  );

  const undo = useCallback(async () => {
    const step = undoStack.at(-1);
    if (!step || busy) return;
    setUndoStack((s) => s.slice(0, -1));
    await run(async () => {
      try {
        await step.undo();
      } catch (e) {
        setUndoStack((s) => [...s, step]);
        throw e;
      }
      setRedoStack((s) => [...s, step]);
      return null;
    });
  }, [undoStack, busy, run]);

  const redo = useCallback(async () => {
    const step = redoStack.at(-1);
    if (!step || busy) return;
    setRedoStack((s) => s.slice(0, -1));
    if (!api) return;
    setBusy(true);
    try {
      await step.redo();
      setUndoStack((s) => [...s, step]);
      await reload();
      onChangedRef.current();
    } catch (e) {
      setRedoStack((s) => [...s, step]);
      fail(e);
    } finally {
      setBusy(false);
    }
  }, [redoStack, busy, api, reload, fail]);

  const setEditMode = useCallback((on: boolean) => {
    setEditModeState(on);
    if (!on) {
      setRenaming(null);
      setMessage(null);
    }
  }, []);

  // leaving the design root (or opening an earlier snapshot) ends edit mode
  useEffect(() => {
    if (!enabled) setEditModeState(false);
  }, [enabled]);

  // Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) over the person's own operations, outside text fields
  useEffect(() => {
    if (!enabled || !editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, editMode, undo, redo]);

  const value: DesignEdits = {
    enabled,
    editMode: enabled && editMode,
    setEditMode,
    projection: design,
    elements,
    element: (id) => (id ? byId.get(id) : undefined),
    canvasElementId,
    canDrawBoxes,
    busy,
    message,
    dismiss: () => setMessage(null),
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.at(-1)?.label,
    redoLabel: redoStack.at(-1)?.label,
    undo,
    redo,
    renaming,
    setRenaming,
    selectedNodes,
    setSelectedNodes,
    addBox,
    addSubsystem,
    addSticky,
    rename,
    setArchetype,
    setStickyText,
    connect,
    setFlowLabel,
    adopt,
    group,
    moveTo,
    remove,
    removeFlows,
    accept,
    reject,
    subsystems: elements.filter((e) => e.body.kind === 'subsystem' && e.status === 'active'),
    refresh: () => onChangedRef.current(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
