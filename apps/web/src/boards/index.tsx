import { useState } from 'react';
import { BoardsHome } from './BoardsHome.tsx';
import { BoardView } from './BoardView.tsx';

/** The Boards tab of the System design root: list, or one open board. */
export function BoardsRoot({ token, projectId }: { token: string; projectId: string }) {
  const [open, setOpen] = useState<string>();
  return open ? (
    <BoardView token={token} boardId={open} onBack={() => setOpen(undefined)} />
  ) : (
    <BoardsHome token={token} projectId={projectId} onOpen={setOpen} />
  );
}
