import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardDocument, ComponentType, DesignBoard } from '@atlas/schema';
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { layoutInWorker } from '../layout.ts';
import { BoardAgentProvider } from './agentContext.tsx';
import { getBoard, saveBoard } from './api.ts';
import { BoardAgentMenu } from './BoardAgentMenu.tsx';
import { BoardInspector } from './BoardInspector.tsx';
import { BoardContext, type BoardContextValue } from './context.ts';
import { BoardController } from './controller.ts';
import { ExportMenu } from './ExportMenu.tsx';
import { ImportAsBuilt } from './ImportAsBuilt.tsx';
import { materialize, needsMaterialize, type El } from './materialize.ts';
import { PALETTE_MIME, Palette } from './Palette.tsx';
import { PresentMode } from './PresentMode.tsx';
import type { BoardSelection } from './registry.ts';
import { clearDecorations, hasDecorations } from './scenarios.ts';
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
const fingerprint = (els: readonly SceneElement[], files: object) =>
  `${els.length}:${els.reduce((n, e) => n + e.version + (e.isDeleted ? 7 : 0), 0)}:${Object.keys(files).length}`;

/** The id of the DOM node in the App's right column the board inspector is portalled into. */
export const BOARD_INSPECTOR_SLOT = 'board-inspector-slot';

/**
 * One design board (D03): the Excalidraw canvas with the component palette on the left and the
 * board inspector in the App's right column. Provides `BoardContext`. Saves are debounced, one in
 * flight at a time with optimistic revisions; the scene is read from Excalidraw at save time and
 * the registry from the local document (see `context.ts` for the contract).
 */
export function BoardView({
  token,
  boardId,
  onBack,
  onOpen,
}: {
  token: string;
  boardId: string;
  onBack: () => void;
  onOpen: (boardId: string) => void;
}) {
  const [board, setBoard] = useState<DesignBoard | null>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved');
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [selection, setSelection] = useState<BoardSelection>({ elementIds: [] });
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [laser, setLaser] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const boardRef = useRef<DesignBoard | null>(null);
  const lastScene = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef(false);
  const dirty = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    setSlot(document.getElementById(BOARD_INSPECTOR_SLOT));
  }, []);

  /** Saves the latest document; while one save is in flight, later edits queue one more. */
  const flush = useCallback(async () => {
    if (saving.current) {
      dirty.current = true;
      return;
    }
    const cur = boardRef.current;
    if (!cur) return;
    pending.current = false;
    saving.current = true;
    dirty.current = false;
    setStatus('saving');
    const a = apiRef.current;
    const document: BoardDocument = a
      ? {
          ...cur.document,
          scene: {
            elements: a.getSceneElements() as unknown as Record<string, unknown>[],
            appState: keptAppState(a.getAppState() as unknown as Record<string, unknown>),
            files: a.getFiles() as unknown as Record<string, unknown>,
          },
        }
      : cur.document;
    let r = await saveBoard(token, cur.id, { document, revision: cur.revision });
    if (!r.ok && 'current' in r) {
      // another tab saved first: this editor's state wins on top of the stored revision
      setStatus('conflict');
      r = await saveBoard(token, cur.id, { document, revision: r.current.revision });
    }
    saving.current = false;
    if (r.ok) {
      const latest = boardRef.current!;
      boardRef.current = { ...latest, revision: r.board.revision, updatedAt: r.board.updatedAt };
      // the retry stored this editor's state: it is saved (the conflict note was transient)
      setStatus('saved');
    } else setStatus('error');
    if (dirty.current) void flush();
  }, [token]);

  const scheduleSave = useCallback(() => {
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 400);
  }, [flush]);

  const patchDocument = useCallback(
    (fn: (doc: BoardDocument) => BoardDocument) => {
      const cur = boardRef.current;
      if (!cur) return;
      const next = fn(cur.document);
      if (next === cur.document) return;
      // the scene is Excalidraw's while mounted: keep whatever scene the ref had
      boardRef.current = { ...cur, document: { ...next, scene: cur.document.scene } };
      setBoard(boardRef.current);
      scheduleSave();
    },
    [scheduleSave],
  );

  const controller = useMemo(
    () =>
      new BoardController({
        getDocument: () => boardRef.current!.document,
        patchDocument,
        getApi: () => apiRef.current,
        onSelection: setSelection,
      }),
    [patchDocument],
  );

  useEffect(() => {
    let cancelled = false;
    getBoard(token, boardId)
      .then(async (b) => {
        // a template/prompt/code board arrives with a registry and no drawing yet
        let document = needsMaterialize(b.document)
          ? await materialize(b.document, layoutInWorker)
          : b.document;
        // a scenario left shown (numbers, dimming) is display state, not part of the drawing (1b)
        if (hasDecorations(document.scene.elements))
          document = {
            ...document,
            scene: {
              ...document.scene,
              elements: clearDecorations(document.scene.elements as never) as never,
            },
          };
        if (cancelled) return;
        const loaded = { ...b, document };
        boardRef.current = loaded;
        setBoard(loaded);
        if (document !== b.document) {
          // save the drawn layout once the canvas is up (the save reads the scene from it)
          dirty.current = false;
          setTimeout(() => void flush(), 50);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      // leaving the board (back, internals, parent): do not drop an edit still waiting to save
      if (pending.current) void flush();
    };
  }, [token, boardId, flush]);

  const onChange = useCallback(
    (elements: readonly El[], appState: AppState, files: object) => {
      if (!boardRef.current) return;
      controller.onSceneChange(elements, appState);
      const fp = fingerprint(elements, files);
      if (fp === lastScene.current) return;
      lastScene.current = fp;
      scheduleSave();
    },
    [controller, scheduleSave],
  );

  const select = useCallback(
    (target: { componentId?: string; connectionId?: string } | null) => controller.select(target),
    [controller],
  );

  const ctx: BoardContextValue | null = useMemo(
    () =>
      board
        ? {
            board,
            api,
            patchDocument,
            selection,
            select,
            controller,
            token,
            openBoard: onOpen,
          }
        : null,
    [board, api, patchDocument, selection, select, controller, token, onOpen],
  );

  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(PALETTE_MIME) as ComponentType;
    const a = apiRef.current;
    if (!type || !a) return;
    e.preventDefault();
    e.stopPropagation();
    const s = a.getAppState();
    controller.addComponent(type, viewportCoordsToSceneCoords(e, s));
  };

  if (error) return <p className="board-error">Could not load this board: {error}</p>;
  if (!board || !ctx) return <p className="board-loading">Loading board…</p>;
  return (
    <BoardContext.Provider value={ctx}>
      <BoardAgentProvider>
        <section
          className={`board-view${presenting ? ' board-presenting' : ''}`}
          aria-label={`Design board: ${board.name}`}
        >
          <header className="board-header">
            <button type="button" className="icon-btn" onClick={onBack}>
              ← Boards
            </button>
            {board.parentBoardId && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => onOpen(board.parentBoardId!)}
                title="Back to the board this one details"
              >
                ↑ Parent board
              </button>
            )}
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
              <BoardAgentMenu />
              <ImportAsBuilt />
              <ExportMenu />
              <button type="button" onClick={() => setPresenting(true)} disabled={!api}>
                Present
              </button>
            </div>
          </header>
          <div className="board-body">
            {!presenting && <Palette />}
            <div
              className="board-canvas"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(PALETTE_MIME)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDropCapture={onDrop}
            >
              <Suspense fallback={<p className="board-loading">Loading canvas…</p>}>
                <Excalidraw
                  excalidrawAPI={(a) => {
                    apiRef.current = a;
                    setApi(a);
                    // open on the whole drawing, not at 100% around its first corner (after mount)
                    setTimeout(
                      () =>
                        a.scrollToContent(undefined, {
                          fitToViewport: true,
                          viewportZoomFactor: 0.85,
                          animate: false,
                        }),
                      120,
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
                  // host-controlled only while presenting (1b); otherwise Excalidraw keeps its toggles
                  viewModeEnabled={presenting ? !laser : undefined}
                  zenModeEnabled={presenting ? laser : undefined}
                  UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
                />
              </Suspense>
            </div>
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
        {slot && createPortal(<BoardInspector />, slot)}
      </BoardAgentProvider>
    </BoardContext.Provider>
  );
}
