import { useState } from 'react';
import { ARCHETYPE_ICON, archetypeLabel } from './archetypes.tsx';
import { WhiteboardTools } from './Palette.tsx';

/**
 * Header toolbar of the System design root. Today it only holds the archetype legend; it is the
 * place for the whiteboard tools of D02a (palette, "Generate design…") so they live in one spot.
 */
export function DesignToolbar() {
  const [legend, setLegend] = useState(false);
  return (
    <div className="design-toolbar" role="toolbar" aria-label="Design tools">
      {/* whiteboard (D02a): Edit toggle, undo, redo; the palette lives on the canvas */}
      <WhiteboardTools />
      <button
        type="button"
        className="icon-btn"
        aria-expanded={legend}
        onClick={() => setLegend((l) => !l)}
      >
        Legend
      </button>
      {legend && (
        <ul className="design-legend" aria-label="Archetypes">
          {Object.entries(ARCHETYPE_ICON).map(([a, icon]) => (
            <li key={a} className={`arch-chip arch-${a}`}>
              <span aria-hidden>{icon}</span> {archetypeLabel(a)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
