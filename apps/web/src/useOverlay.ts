import { useCallback, useRef, useState } from 'react';
import { saveOverlay, type OverlayDto } from './api.ts';

/**
 * One writer for the current view's overlay: edits apply locally at once and are saved after a short
 * debounce with an optimistic revision; on a conflict the edit is re-applied on top of the stored one.
 */
export function useOverlay(token: string | null) {
  const overlayRef = useRef<OverlayDto | null>(null);
  const [overlay, setOverlay] = useState<OverlayDto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queued = useRef<((o: OverlayDto) => OverlayDto)[]>([]);
  const saving = useRef(false);

  const persist = useCallback(
    (mutate: (o: OverlayDto) => OverlayDto) => {
      const cur = overlayRef.current;
      if (!cur || !token) return;
      const next = mutate(cur);
      overlayRef.current = next;
      setOverlay(next);
      queued.current.push(mutate);
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        saving.current = true;
        const edits = queued.current.splice(0);
        let r = await saveOverlay(token, overlayRef.current!);
        if (!r.ok) {
          const rebased = edits.reduce((o, m) => m(o), r.overlay);
          r = await saveOverlay(token, { ...rebased, revision: r.overlay.revision });
        }
        // edits made while this save was in flight are still queued: keep them on top of the
        // stored overlay, or the next save would write the overlay without them
        const latest = queued.current.reduce((o, m) => m(o), r.overlay);
        overlayRef.current = latest;
        setOverlay(latest);
        saving.current = false;
      }, 350);
    },
    [token],
  );

  const reset = useCallback((o: OverlayDto | null) => {
    overlayRef.current = o;
    setOverlay(o);
  }, []);

  /** True while edits are queued or being saved: the local overlay is newer than the stored one. */
  const isDirty = useCallback(() => saving.current || queued.current.length > 0, []);

  return { overlayRef, overlay, persist, reset, isDirty };
}
