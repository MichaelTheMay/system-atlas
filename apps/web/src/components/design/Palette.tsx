import { useEffect, useState } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { ARCHETYPE_ICON, archetypeLabel } from './archetypes.tsx';
import { ARCHETYPES, type Archetype } from './designApi.ts';
import { isDetectedBox, isDrawn, useDesignEdits } from './useDesignEdits.tsx';
import './whiteboard.css';

/**
 * Whiteboard tools (D02a): the Edit toggle with undo/redo in the design toolbar, and on the canvas
 * the archetype palette (drag or click to add), the selection bar (group, move, delete) and the
 * status line that reports conflicts and offers Undo.
 */

export const PALETTE_MIME = 'application/x-atlas-design-tool';
export type PaletteTool = { kind: 'box'; archetype: Archetype } | { kind: 'subsystem' | 'sticky' };

/** Header tools: Edit toggle, Undo, Redo. */
export function WhiteboardTools() {
  const ed = useDesignEdits();
  if (!ed) return null;
  return (
    <>
      <button
        type="button"
        className={`icon-btn${ed.editMode ? ' wb-edit-on' : ''}`}
        aria-pressed={ed.editMode}
        disabled={!ed.enabled}
        title={
          ed.enabled
            ? 'Draw on the board: add boxes, connect flows, group, rename and delete'
            : 'Editing works on the latest snapshot of the System design root'
        }
        onClick={() => ed.setEditMode(!ed.editMode)}
      >
        {ed.editMode ? 'Done editing' : 'Edit'}
      </button>
      {ed.editMode && (
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label="Undo"
            title={ed.undoLabel ? `Undo ${ed.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
            disabled={!ed.canUndo || ed.busy}
            onClick={() => void ed.undo()}
          >
            ↶
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Redo"
            title={ed.redoLabel ? `Redo ${ed.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
            disabled={!ed.canRedo || ed.busy}
            onClick={() => void ed.redo()}
          >
            ↷
          </button>
        </>
      )}
    </>
  );
}

/** On-canvas whiteboard layer; `place` pins a new node where it was dropped or added. */
export function WhiteboardLayer({
  place,
  clearSelection,
}: {
  place(nodeId: string, pos: { x: number; y: number }): void;
  clearSelection(): void;
}) {
  const ed = useDesignEdits();
  const flow = useReactFlow();
  const [collapsed, setCollapsed] = useState(false);
  if (!ed?.projection) return null;
  /** Click-to-add: the new node lands in the middle of the visible canvas, nudged per click. */
  const addAt = async (tool: PaletteTool) => {
    const id = await addTool(tool);
    if (!id) return;
    const spot = freeSpot();
    place(id, spot);
    // no free room on screen: the node went below the board, so bring it into view
    if (spot.offscreen)
      void flow.setCenter(spot.x + 115, spot.y + 50, { zoom: flow.getZoom(), duration: 0 });
  };
  /**
   * Click-to-add: the first free spot of the visible canvas, scanning rows from the top middle
   * outwards, clear of other nodes and of the palette; else below the lowest node (never under
   * the palette, which would make it unclickable).
   */
  const freeSpot = () => {
    const r = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0, offscreen: false };
    const tl = flow.screenToFlowPosition({ x: r.left + 16, y: r.top + 16 });
    const br = flow.screenToFlowPosition({ x: r.right - 16, y: r.bottom - 16 });
    const taken = flow.getNodes().map((n) => {
      const p = flow.getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
      return { x: p.x, y: p.y, w: n.measured?.width ?? 220, h: n.measured?.height ?? 80 };
    });
    const bottom = Math.max(0, ...taken.map((t) => t.y + t.h));
    // the palette and the minimap float over the canvas: never drop a node underneath them
    for (const sel of ['.wb-palette', '.react-flow__minimap']) {
      const pr = document.querySelector(sel)?.getBoundingClientRect();
      if (!pr) continue;
      const a = flow.screenToFlowPosition({ x: pr.left, y: pr.top });
      const b = flow.screenToFlowPosition({ x: pr.right, y: pr.bottom });
      taken.push({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
    }
    const W = 230;
    const H = 100;
    const free = (x: number, y: number) =>
      !taken.some(
        (t) => x < t.x + t.w + 16 && x + W > t.x - 16 && y < t.y + t.h + 16 && y + H > t.y - 16,
      );
    const mid = (tl.x + br.x) / 2 - W / 2;
    const cols = Math.max(1, Math.floor((br.x - tl.x) / (W + 20)));
    const xs = Array.from(
      { length: cols },
      (_, i) => mid + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (W + 20),
    ).filter((x) => x >= tl.x && x + W <= br.x);
    for (let y = tl.y + 20; y + H <= br.y; y += H + 20)
      for (const x of xs)
        if (free(x, y)) return { x: Math.round(x), y: Math.round(y), offscreen: false };
    return { x: Math.round(mid), y: Math.round(bottom + 40), offscreen: true };
  };
  const addTool = (tool: PaletteTool) =>
    tool.kind === 'box'
      ? ed.addBox(tool.archetype)
      : tool.kind === 'subsystem'
        ? ed.addSubsystem()
        : ed.addSticky();
  return (
    <>
      {ed.editMode && (
        <Panel
          position="top-left"
          className={`wb-palette${collapsed ? ' collapsed' : ''}`}
          aria-label="Archetype palette"
        >
          <div className="wb-palette-title">
            Add
            <button
              type="button"
              className="wb-mini ghost-btn"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Show palette' : 'Hide palette'}
              title={collapsed ? 'Show palette' : 'Hide palette'}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          </div>
          {!collapsed && (
            <>
              {/* boxes only show on the root and on drawn subsystems: elsewhere, notes only */}
              {ed.canDrawBoxes ? (
                <>
                  {ARCHETYPES.map((a) => (
                    <PaletteItem
                      key={a}
                      tool={{ kind: 'box', archetype: a }}
                      icon={ARCHETYPE_ICON[a] ?? '•'}
                      label={archetypeLabel(a)}
                      className={`arch-${a}`}
                      disabled={ed.busy}
                      onAdd={addAt}
                    />
                  ))}
                  <PaletteItem
                    tool={{ kind: 'subsystem' }}
                    icon="⊞"
                    label="subsystem"
                    className="wb-sub"
                    disabled={ed.busy}
                    onAdd={addAt}
                  />
                </>
              ) : (
                <p className="wb-palette-note">
                  Boxes are drawn on the System design root or inside a drawn subsystem.
                </p>
              )}
              <PaletteItem
                tool={{ kind: 'sticky' }}
                icon="✎"
                label="sticky note"
                className="wb-note"
                disabled={ed.busy}
                onAdd={addAt}
              />
              <p className="wb-palette-hint">
                Drag onto the board or click.
                {ed.canDrawBoxes && ' Drag from the right edge of a box to connect.'}
              </p>
            </>
          )}
        </Panel>
      )}
      {ed.editMode && ed.selectedNodes.length > 0 && (
        <SelectionBar clearSelection={clearSelection} />
      )}
      {ed.message && (
        <Panel position="bottom-center" className={`wb-status ${ed.message.tone}`}>
          <span role="status">{ed.message.text}</span>
          {ed.message.undoable && ed.canUndo && (
            <button type="button" className="wb-mini" onClick={() => void ed.undo()}>
              Undo
            </button>
          )}
          <button
            type="button"
            className="wb-mini ghost-btn"
            aria-label="Dismiss"
            onClick={ed.dismiss}
          >
            ×
          </button>
        </Panel>
      )}
    </>
  );
}

function PaletteItem({
  tool,
  icon,
  label,
  className,
  disabled,
  onAdd,
}: {
  tool: PaletteTool;
  icon: string;
  label: string;
  className: string;
  disabled: boolean;
  onAdd(tool: PaletteTool): Promise<void>;
}) {
  return (
    <button
      type="button"
      className={`wb-tool ${className}`}
      draggable={!disabled}
      disabled={disabled}
      aria-label={`Add ${label}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(tool));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => void onAdd(tool)}
    >
      <span className="wb-tool-icon" aria-hidden>
        {icon}
      </span>
      {label}
    </button>
  );
}

/** Actions on the multi-selection: group into a subsystem (inline name), move, delete/hide. */
function SelectionBar({ clearSelection }: { clearSelection(): void }) {
  const ed = useDesignEdits()!;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const sel = ed.selectedNodes;
  useEffect(() => {
    if (!sel.length) setNaming(false);
  }, [sel.length]);
  const groupable = sel.filter((n) => isDetectedBox(n) || (isDrawn(n) && n.kind !== 'sticky'));
  const movable = sel.filter(
    (n) => isDetectedBox(n) || (isDrawn(n) && (n.kind === 'design' || n.kind === 'cluster')),
  );
  const removable = sel.filter((n) => isDetectedBox(n) || !!n.designElementId);
  const drawnHere = ed.canDrawBoxes;
  const parentOfCanvas = ed.canvasElementId ? ed.element(ed.canvasElementId)?.body : undefined;
  const outTo =
    parentOfCanvas && parentOfCanvas.kind === 'subsystem' ? parentOfCanvas.parentId : undefined;
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setNaming(false);
    setName('');
    await ed.group(groupable, n);
    clearSelection();
  };
  return (
    <Panel position="top-center" className="wb-selbar" aria-label="Selection actions">
      <span className="wb-selcount">{sel.length} selected</span>
      {naming ? (
        <form
          className="wb-group-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            aria-label="Subsystem name"
            placeholder="Subsystem name"
            maxLength={80}
            value={name}
            className="wb-inline"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button type="submit" className="wb-mini primary" disabled={!name.trim() || ed.busy}>
            Group
          </button>
          <button type="button" className="wb-mini" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          {groupable.length > 0 && (
            <button
              type="button"
              className="wb-mini"
              disabled={ed.busy}
              onClick={() => setNaming(true)}
            >
              Group into subsystem…
            </button>
          )}
          {drawnHere && movable.length > 0 && (ed.subsystems.length > 0 || ed.canvasElementId) && (
            <select
              aria-label="Move to subsystem"
              className="wb-select"
              value=""
              disabled={ed.busy}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                void ed.moveTo(movable, v === '__top' ? outTo : v);
              }}
            >
              <option value="">Move to…</option>
              {ed.canvasElementId && <option value="__top">Out of this subsystem</option>}
              {ed.subsystems
                .filter(
                  (s) =>
                    s.id !== ed.canvasElementId && !movable.some((m) => m.designElementId === s.id),
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.body.kind === 'subsystem' ? s.body.label : s.id}
                  </option>
                ))}
            </select>
          )}
          {removable.length > 0 && (
            <button
              type="button"
              className="wb-mini danger"
              disabled={ed.busy}
              title="Drawn elements are deleted; detected boxes are hidden (code facts are kept)"
              onClick={() => {
                void ed.remove(removable);
                clearSelection();
              }}
            >
              Delete
            </button>
          )}
        </>
      )}
    </Panel>
  );
}
