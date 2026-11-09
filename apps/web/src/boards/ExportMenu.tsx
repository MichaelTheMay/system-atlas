import { useEffect, useRef, useState } from 'react';
import { useBoard } from './context.ts';
import { exportBoard } from './export.ts';

const ITEMS = [
  ['png', 'PNG image'],
  ['svg', 'SVG image'],
  ['excalidraw', 'Excalidraw scene (.excalidraw)'],
  ['markdown-zip', 'Markdown design doc + PNG (.zip)'],
  ['markdown', 'Markdown design doc (.md)'],
] as const;

/** Toolbar "Export ▾" of a board (D03 wave 1b); see export.ts for the formats. */
export function ExportMenu() {
  const { board, api } = useBoard();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!api || busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? 'Exporting…' : 'Export ▾'}
      </button>
      {open && (
        <div className="export-items" role="menu" aria-label="Export">
          {ITEMS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                if (!api) return;
                setOpen(false);
                setBusy(true);
                setError(undefined);
                exportBoard(kind, api, board)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <span className="board-error-inline" role="alert">
          Export failed: {error}
        </span>
      )}
    </div>
  );
}
