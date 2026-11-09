import { useEffect, useState } from 'react';
import { BoardsHome } from './BoardsHome.tsx';
import { BoardView } from './BoardView.tsx';
import { flowSession } from './flowSession.ts';

/** The Boards tab of the System design root: list, or one open board. */
export function BoardsRoot({ token, projectId }: { token: string; projectId: string }) {
  const [open, setOpen] = useState<string>();
  // following a flow across boards only lasts while the user stays on its path (D04)
  useEffect(() => {
    if (open) flowSession.arrived(open);
    else flowSession.reset();
  }, [open]);
  return open ? (
    <BoardView
      key={open}
      token={token}
      boardId={open}
      onBack={() => setOpen(undefined)}
      onOpen={setOpen}
    />
  ) : (
    <BoardsHome token={token} projectId={projectId} onOpen={setOpen} />
  );
}
