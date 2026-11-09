import { useEffect, useState } from 'react';
import { useBoard } from './context.ts';
import { fromCodeStatus, importAsBuilt } from './fromCode.ts';

/** Toolbar "Import as built": adds the code's derived design to this board (only with a snapshot). */
export function ImportAsBuilt() {
  const ctx = useBoard();
  const { token, board } = ctx;
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void fromCodeStatus(token, board.projectId)
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, [token, board.projectId]);
  if (!available) return null;
  return (
    <>
      <button
        type="button"
        disabled={!ctx.api || busy}
        title="Add the code's derived design next to this drawing, faded, in an “As built” frame"
        onClick={() => {
          setBusy(true);
          setError(undefined);
          importAsBuilt(ctx)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Importing…' : 'Import as built'}
      </button>
      {error && (
        <span className="board-error-inline" role="alert">
          Import failed: {error}
        </span>
      )}
    </>
  );
}
