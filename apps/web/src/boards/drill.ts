import type { DrillResolver } from '@atlas/export';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import { getBoard } from './api.ts';

/**
 * The internals boards a board's flows drill into (D04), fetched two levels deep (boards nest no
 * deeper), for the nested sequence view and the Markdown export. Boards that cannot be read are
 * left out: the diagram is then drawn without that sub-flow.
 */
export async function loadDrillBoards(
  token: string,
  doc: BoardDocument,
  scenarioId?: string,
): Promise<Map<string, DesignBoard>> {
  const found = new Map<string, DesignBoard>();
  const wanted = (d: BoardDocument, only?: string) =>
    d.scenarios
      .filter((s) => !only || s.id === only)
      .flatMap((s) => s.steps.flatMap((st) => (st.drillInto ? [st.drillInto] : [])));
  let next = wanted(doc, scenarioId);
  for (let depth = 0; depth < 2 && next.length; depth++) {
    const round = next.filter((d) => !found.has(d.boardId));
    const boards = await Promise.all(
      [...new Set(round.map((d) => d.boardId))].map((id) =>
        getBoard(token, id).catch(() => undefined),
      ),
    );
    for (const b of boards) if (b) found.set(b.id, b);
    next = round.flatMap((d) => {
      const b = found.get(d.boardId);
      return b ? wanted(b.document, d.scenarioId) : [];
    });
  }
  return found;
}

export const drillResolver =
  (boards: Map<string, DesignBoard>): DrillResolver =>
  (drill) => {
    const b = boards.get(drill.boardId);
    const scenario = b?.document.scenarios.find((s) => s.id === drill.scenarioId);
    return b && scenario ? { doc: b.document, scenario, boardName: b.name } : undefined;
  };
