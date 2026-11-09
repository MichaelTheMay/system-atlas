import { createElement, useMemo, useState } from 'react';
import { COMPONENT_CATALOG, type ComponentFamily } from '@atlas/schema';
import { useBoard } from './context.ts';
import { iconNode } from './icons.ts';
import { FAMILY_STYLE } from './materialize.ts';

/** Drag payload type: only Atlas reads it (Excalidraw would turn text/plain into a text element). */
export const PALETTE_MIME = 'application/x-atlas-component';

export const FAMILY_LABEL: Record<ComponentFamily, string> = {
  edge: 'Clients & edge',
  compute: 'Compute',
  data: 'Data',
  messaging: 'Messaging',
  'cross-cutting': 'Cross-cutting',
  external: 'External',
  boundary: 'Boundaries',
  people: 'People & process',
  generic: 'Generic',
};

/**
 * Component palette (D03 wave 1a): the catalog grouped by family, searchable; click adds the
 * component at a free spot in view, drag drops it where released. Also adds frames and stickies.
 */
export function Palette() {
  const { controller } = useBoard();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = COMPONENT_CATALOG.filter(
      (c) =>
        !needle ||
        c.label.toLowerCase().includes(needle) ||
        c.type.includes(needle) ||
        c.family.includes(needle),
    );
    const out = new Map<ComponentFamily, typeof hits>();
    for (const c of hits) out.set(c.family, [...(out.get(c.family) ?? []), c]);
    return [...out];
  }, [q]);

  return (
    <nav className="board-palette" aria-label="Component palette">
      <input
        type="search"
        className="board-palette-search"
        placeholder="Search components"
        aria-label="Search components"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="board-palette-extras">
        <button type="button" onClick={() => controller.addFrame()}>
          + Frame
        </button>
        <button type="button" onClick={() => controller.addSticky()}>
          + Sticky note
        </button>
      </div>
      <div className="board-palette-groups">
        {groups.map(([family, items]) => (
          <section key={family} className="board-palette-group">
            <h3>{FAMILY_LABEL[family]}</h3>
            <ul>
              {items.map((c) => (
                <li key={c.type}>
                  <button
                    type="button"
                    className="board-palette-item"
                    draggable
                    aria-label={`Add ${c.label}`}
                    title={`Add ${c.label} (click, or drag onto the board)`}
                    onClick={() => controller.addComponent(c.type)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_MIME, c.type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <span
                      className="board-palette-icon"
                      style={{ background: FAMILY_STYLE[c.family].fill }}
                    >
                      <ComponentIcon name={c.icon} color={FAMILY_STYLE[c.family].stroke} />
                    </span>
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="empty-note">No component matches “{q}”.</p>}
      </div>
    </nav>
  );
}

/** A catalog icon as inline React SVG (same Lucide set as the canvas). */
export function ComponentIcon({
  name,
  color = 'currentColor',
  size = 16,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconNode(name).map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
