import { useEffect, useState } from 'react';
import {
  createBoard,
  deleteBoard,
  listBoards,
  listBoardTemplates,
  type BoardTemplateDto,
  type DesignBoardSummary,
} from './api.ts';
import { createBoardFromCode, fromCodeStatus } from './fromCode.ts';

/** Board list and "New board" of a project (D03 wave 0). Wave 1 adds prompt and code starts. */
export function BoardsHome({
  token,
  projectId,
  onOpen,
}: {
  token: string;
  projectId: string;
  onOpen: (boardId: string) => void;
}) {
  const [boards, setBoards] = useState<DesignBoardSummary[]>([]);
  const [templates, setTemplates] = useState<BoardTemplateDto[]>([]);
  const [name, setName] = useState('');
  const [start, setStart] = useState('blank');
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [error, setError] = useState<string>();
  const [fromCode, setFromCode] = useState(false);
  const reload = () =>
    listBoards(token, projectId)
      .then(setBoards)
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    void reload();
    void listBoardTemplates(token).then(setTemplates);
    // "From code" is offered only when the project has a snapshot to import
    void fromCodeStatus(token, projectId)
      .then((s) => setFromCode(s.available))
      .catch(() => setFromCode(false));
  }, [token, projectId]);

  const create = async () => {
    if (start === 'code') {
      try {
        const b = await createBoardFromCode(token, projectId, { name: name.trim() || undefined });
        setName('');
        onOpen(b.id);
      } catch (e) {
        setError(`Could not import from code: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const tpl = templates.find((t) => t.id === start);
    const b = await createBoard(token, projectId, {
      name: name.trim() || tpl?.name || 'Untitled board',
      source: tpl ? 'template' : 'blank',
      templateId: tpl?.id,
    });
    setName('');
    onOpen(b.id);
  };

  return (
    <section className="boards-home" aria-label="Design boards">
      <form
        className="boards-new"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2>New board</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout" />
        </label>
        <label>
          Start from
          <select value={start} onChange={(e) => setStart(e.target.value)}>
            <option value="blank">Blank board</option>
            {fromCode && <option value="code">From code (as built, latest snapshot)</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                Template: {t.name} ({t.componentCount} components)
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          Create board
        </button>
        <p className="boards-hint">
          Boards are design-first: draw how the system should work, then hand it to people or
          agents. Nothing on a board is read as a fact about the code.
        </p>
      </form>
      {error && <p className="board-error">{error}</p>}
      <ul className="boards-list" aria-label="Boards">
        {boards.map((b) => (
          <li key={b.id} className="board-card">
            <button type="button" className="board-open" onClick={() => onOpen(b.id)}>
              <span className="board-card-name">{b.name}</span>
              <span className="board-card-meta">
                {b.componentCount} component(s) · {b.source}
                {b.templateId ? ` (${b.templateId})` : ''} · updated{' '}
                {new Date(b.updatedAt).toLocaleString()}
              </span>
            </button>
            {confirmDelete === b.id ? (
              <span className="board-card-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => void deleteBoard(token, b.id).then(reload)}
                >
                  Confirm delete
                </button>
                <button type="button" onClick={() => setConfirmDelete(undefined)}>
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${b.name}`}
                onClick={() => setConfirmDelete(b.id)}
              >
                Delete
              </button>
            )}
          </li>
        ))}
        {boards.length === 0 && <li className="boards-empty">No boards yet.</li>}
      </ul>
    </section>
  );
}
