import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { getBoard, saveBoard } from './api.ts';
import {
  BoardContext,
  elementsOf,
  selectionFrom,
  selectionKey,
  type BoardContextValue,
  type BoardSelection,
} from './context.ts';
import { DocPanel } from './DocPanel.tsx';
import { ExportMenu } from './ExportMenu.tsx';
import { materialize, needsMaterialize } from './materialize.ts';
import { PresentMode } from './PresentMode.tsx';
import { clearDecorations, hasDecorations } from './scenarios.ts';
import { ScenariosPanel } from './ScenariosPanel.tsx';
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
 * One design board (D03): the Excalidraw canvas over a stored scene, saved with optimistic
 * revisions after a short debounce, and the side panels (scenarios, design doc), export menu and
 * presentation mode, which share the board through `BoardContext`.
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
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const [apiState, setApiState] = useState<ExcalidrawImperativeAPI | null>(null);
  const [selection, setSelection] = useState<BoardSelection>({ elementIds: [] });
  const selKey = useRef('');
  const [side, setSide] = useState<'scenarios' | 'doc'>('scenarios');
  const [presenting, setPresenting] = useState(false);
  const [laser, setLaser] = useState(false);
  const boardRef = useRef<DesignBoard | null>(null);
  const lastSaved = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Saves are serialized: one PATCH in flight, and one more queued if anything changed meanwhile. */
  const saving = useRef(false);
  const dirty = useRef(false);

  /** Saves the latest local document; edits made while a save is in flight are saved right after. */
  const persist = useCallback(async () => {
    if (saving.current) {
      dirty.current = true;
      return;
    }
    saving.current = true;
    try {
      do {
        dirty.current = false;
        const cur = boardRef.current;
        if (!cur) return;
        setStatus('saving');
        const r = await saveBoard(token, cur.id, {
          document: cur.document,
          revision: cur.revision,
        });
        // keep local edits made during the request: only the revision comes from the server
        const latest = boardRef.current ?? cur;
        if (r.ok) {
          boardRef.current = {
            ...latest,
            revision: r.board.revision,
            updatedAt: r.board.updatedAt,
          };
          setStatus('saved');
        } else if ('current' in r) {
          // another tab saved first: keep editing on top of the stored revision
          boardRef.current = { ...latest, revision: r.current.revision };
          setStatus('conflict');
        } else setStatus('error');
      } while (dirty.current);
    } finally {
      saving.current = false;
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    getBoard(token, boardId)
      .then((b) => {
        if (cancelled) return;
        // a template/prompt/code board arrives with a registry and no drawing yet
        let document = needsMaterialize(b.document) ? materialize(b.document) : b.document;
        // a scenario left shown (numbers, dimming) is display state, not part of the drawing
        if (hasDecorations(document.scene.elements))
          document = {
            ...document,
            scene: {
              ...document.scene,
              elements: clearDecorations(document.scene.elements as never) as never,
            },
          };
        const loaded = { ...b, document };
        boardRef.current = loaded;
        lastSaved.current = fingerprint(document.scene.elements as unknown as SceneElement[]);
        setBoard(loaded);
        if (document !== b.document) void persist();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [token, boardId, persist]);

  /** Registry edits from the side panels: merged into the latest document and saved. */
  const patchDocument = useCallback(
    (fn: (doc: BoardDocument) => BoardDocument) => {
      const cur = boardRef.current;
      if (!cur) return;
      const next = fn(cur.document);
      const document: BoardDocument = {
        ...cur.document,
        components: next.components,
        connections: next.connections,
        scenarios: next.scenarios,
        doc: next.doc,
        frames: next.frames,
      };
      boardRef.current = { ...cur, document };
      setBoard(boardRef.current);
      void persist();
    },
    [persist],
  );

  /** Select a component or connection on the canvas and bring it into view. */
  const select = useCallback((target: { componentId?: string; connectionId?: string } | null) => {
    const a = api.current;
    if (!a) return;
    const els = a.getSceneElements();
    const picked = !target
      ? []
      : target.componentId
        ? elementsOf(els, { kind: 'component', id: target.componentId })
        : target.connectionId
          ? elementsOf(els, { kind: 'connection', id: target.connectionId })
          : [];
    a.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(picked.map((e) => [e.id, true])),
      } as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (picked.length)
      a.scrollToContent(picked as never, {
        fitToViewport: true,
        viewportZoomFactor: 0.4,
        maxZoom: 1,
        animate: true,
      });
  }, []);

  const onChange = useCallback(
    (elements: readonly SceneElement[], appState: Record<string, unknown>, files: unknown) => {
      // selection for the side panels, through the atlas tags (state only when it changes)
      const sel = selectionFrom(
        elements,
        (appState.selectedElementIds ?? {}) as Record<string, boolean | undefined>,
      );
      const key = selectionKey(sel);
      if (key !== selKey.current) {
        selKey.current = key;
        setSelection(sel);
      }
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
        void persist();
      }, 600);
    },
    [persist],
  );

  const ctx = useMemo<BoardContextValue | null>(
    () => (board ? { board, api: apiState, patchDocument, selection, select } : null),
    [board, apiState, patchDocument, selection, select],
  );

  if (error) return <p className="board-error">Could not load this board: {error}</p>;
  if (!board || !ctx) return <p className="board-loading">Loading board…</p>;
  return (
    <BoardContext.Provider value={ctx}>
      <section
        className={`board-view${presenting ? ' board-presenting' : ''}`}
        aria-label={`Design board: ${board.name}`}
      >
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
          <div className="board-tools">
            <ExportMenu />
            <button type="button" onClick={() => setPresenting(true)} disabled={!apiState}>
              Present
            </button>
          </div>
        </header>
        <div className="board-body">
          <div className="board-canvas">
            <Suspense fallback={<p className="board-loading">Loading canvas…</p>}>
              <Excalidraw
                excalidrawAPI={(a) => {
                  api.current = a;
                  setApiState(a);
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
                viewModeEnabled={presenting && !laser}
                zenModeEnabled={presenting && laser}
                UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
              />
            </Suspense>
          </div>
          {!presenting && (
            <aside className="board-side" aria-label="Board panels">
              {/* Properties (wave 1a) mounts as the first tab here */}
              <div className="board-side-tabs" role="tablist" aria-label="Board panels">
                <button
                  type="button"
                  role="tab"
                  aria-selected={side === 'scenarios'}
                  onClick={() => setSide('scenarios')}
                >
                  Scenarios
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={side === 'doc'}
                  onClick={() => setSide('doc')}
                >
                  Design doc
                </button>
              </div>
              <div className="board-side-body" role="tabpanel">
                {side === 'scenarios' ? <ScenariosPanel /> : <DocPanel />}
              </div>
            </aside>
          )}
        </div>
        {presenting && (
          <PresentMode
            laser={laser}
            onLaser={setLaser}
            onExit={() => {
              setLaser(false);
              setPresenting(false);
            }}
          />
        )}
      </section>
    </BoardContext.Provider>
  );
}
