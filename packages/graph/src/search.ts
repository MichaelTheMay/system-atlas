import type { Db } from '@atlas/store';

export interface SearchHit {
  id: string;
  kind: string;
  displayName: string;
  canonicalName: string;
  path?: string;
}

/**
 * Full-text entity search within one snapshot (FTS5 over canonical and display names). The query
 * is reduced to quoted prefix terms, so user input can never use FTS syntax (NEAR, column filters,
 * boolean operators) or fail to parse.
 */
export function searchEntities(
  db: Db,
  snapshotId: string,
  query: string,
  opts: { kind?: string; limit?: number } = {},
): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_\-./:]+/u)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"*`).join(' ');
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.display_name AS displayName, e.canonical_name AS canonicalName, e.attributes
       FROM entity_search s JOIN entities e ON e.snapshot_id = s.snapshot_id AND e.id = s.entity_id
       WHERE entity_search MATCH ? AND s.snapshot_id = ? ${opts.kind ? 'AND s.kind = ?' : ''}
       ORDER BY bm25(entity_search), length(e.canonical_name), e.id LIMIT ?`,
    )
    .all<SearchHit & { attributes: string }>(
      ...([match, snapshotId, ...(opts.kind ? [opts.kind] : []), limit] as string[]),
    );
  return rows.map(({ attributes, ...h }) => {
    const path = (JSON.parse(attributes) as { path?: unknown }).path;
    return typeof path === 'string' ? { ...h, path } : h;
  });
}
