import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import type { Excalidraw as ExcalidrawComponent } from '@excalidraw/excalidraw';
import { getBoard, saveBoard } from './api.ts';
import { materialize, needsMaterialize } from './materialize.ts';
import '@excalidraw/excalidraw/index.css';

// Excalidraw fonts come from the app origin (served by Vite in dev, copied into dist at build).
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH ??= '/';

const Excalidraw = lazy(() =>
  import('@excalidraw/excalidraw').then((m) => ({ default: m.Excalidraw })),
);
type SceneElement = { id: string; version: number; isDeleted?: boolean };

/** Subset of Excalidraw appState worth keeping between sessions. */
const keptAppState = (s: Record<string, unknown>) =>
  Object.fromEntries(
    ['viewBackgroundColor', 'gridSize', 'currentItemFontFamily'].flatMap((k) =>
      s[k] !== undefined ? [[k, s[k]]] : [],
    ),
  );
const fingerprint = (els: readonly SceneElement[]) =>
  `${els.length}:${els.reduce((n, e) => n + e.version + (e.isDeleted ? 7 : 0), 0)}`;

/**
 * One design board (D03 wave 0): the Excalidraw canvas over a stored scene, saved with optimistic
 * revisions after a short debounce. Wave 1 adds the component palette, inspector, scenarios,
 * design doc, export and presentation on top of this.
 */
export function BoardView({
  token,
  boardId,
  onBack,
}: {
  token: string;
  boardId: string;
  onBack: () => void;
}) {
  const [board, setBoard] = useState<DesignBoard | null>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved');
  const api = useRef<
    Parameters<NonNullable<Parameters<typeof ExcalidrawComponent>[0]['excalidrawAPI']>>[0] | null
  >(null);
  const boardRef = useRef<DesignBoard | null>(null);
  const lastSaved = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    getBoard(token, boardId)
      .then((b) => {
        if (cancelled) return;
        // a template/prompt/code board arrives with a registry and no drawing yet
        const document = needsMaterialize(b.document) ? materialize(b.document) : b.document;
        const loaded = { ...b, document };
        boardRef.current = loaded;
        lastSaved.current = fingerprint(document.scene.elements as unknown as SceneElement[]);
        setBoard(loaded);
        if (document !== b.document) void persist(document);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [token, boardId]);

  const persist = useCallback(
    async (document: BoardDocument) => {
      const cur = boardRef.current;
      if (!cur) return;
      setStatus('saving');
      const r = await saveBoard(token, cur.id, { document, revision: cur.revision });
      if (r.ok) {
        boardRef.current = r.board;
        setStatus('saved');
      } else if ('current' in r) {
        // another tab saved first: keep editing on top of the stored revision
        boardRef.current = { ...cur, revision: r.current.revision };
        setStatus('conflict');
      } else setStatus('error');
    },
    [token],
  );

  const onChange = useCallback(
    (elements: readonly SceneElement[], appState: Record<string, unknown>, files: unknown) => {
      const fp = fingerprint(elements);
      if (fp === lastSaved.current) return;
      lastSaved.current = fp;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const cur = boardRef.current;
        if (!cur) return;
        const document: BoardDocument = {
          ...cur.document,
          scene: {
            elements: elements.filter((e) => !e.isDeleted) as unknown as Record<string, unknown>[],
            appState: keptAppState(appState),
            files: (files ?? {}) as Record<string, unknown>,
          },
        };
        boardRef.current = { ...cur, document };
        void persist(document);
      }, 600);
    },
    [persist],
  );

  if (error) return <p className="board-error">Could not load this board: {error}</p>;
  if (!board) return <p className="board-loading">Loading board…</p>;
  return (
    <section className="board-view" aria-label={`Design board: ${board.name}`}>
      <header className="board-header">
        <button type="button" className="icon-btn" onClick={onBack}>
          ← Boards
        </button>
        <h2 className="board-title">{board.name}</h2>
        <span className={`board-status board-status-${status}`} aria-live="polite">
          {status === 'saved'
            ? 'Saved'
            : status === 'saving'
              ? 'Saving…'
              : status === 'conflict'
                ? 'Saved elsewhere — reloaded revision'
                : 'Save failed'}
        </span>
        <span className="board-meta">
          {Object.keys(board.document.components).length} component(s)
        </span>
      </header>
      <div className="board-canvas">
        <Suspense fallback={<p className="board-loading">Loading canvas…</p>}>
          <Excalidraw
            excalidrawAPI={(a) => {
              api.current = a;
              // open on the whole drawing, not at 100% around its first corner (after mount)
              setTimeout(
                () => a.scrollToContent(undefined, { fitToContent: true, animate: false }),
                0,
              );
            }}
            initialData={{
              elements: board.document.scene.elements as never,
              appState: {
                ...board.document.scene.appState,
                viewBackgroundColor: '#fffdf7',
              } as never,
              files: board.document.scene.files as never,
            }}
            onChange={onChange as never}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
          />
        </Suspense>
      </div>
    </section>
  );
}
