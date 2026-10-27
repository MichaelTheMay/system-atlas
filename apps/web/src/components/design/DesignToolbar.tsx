import { useState, type ReactNode } from 'react';
import { ARCHETYPE_ICON, archetypeLabel } from './archetypes.tsx';

/**
 * Header toolbar of the System design root. Today it only holds the archetype legend; it is the
 * place for the whiteboard tools of D02a (palette, "Generate design…") so they live in one spot.
 * `children`: extra tools after the legend (D02b: Copilot and Generate design…).
 */
export function DesignToolbar({ children }: { children?: ReactNode } = {}) {
  const [legend, setLegend] = useState(false);
  return (
    <div className="design-toolbar" role="toolbar" aria-label="Design tools">
      <button
        type="button"
        className="icon-btn"
        aria-expanded={legend}
        onClick={() => setLegend((l) => !l)}
      >
        Legend
      </button>
      {children}
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
