import type { Db } from '@atlas/store';

export interface IssueRecord {
  id: string;
  projectId: string;
  snapshotId: string;
  kind: string;
  status: 'open' | 'resolved' | 'dismissed';
  detail: Record<string, unknown> & {
    from?: string[];
    to?: string[];
    fromIds?: string[];
    toIds?: string[];
    links?: { fromId: string; toId: string; at: string }[];
  };
  createdAt: string;
}

interface Row {
  id: string;
  project_id: string;
  snapshot_id: string;
  kind: string;
  status: IssueRecord['status'];
  body: string;
  created_at: string;
}

const toRecord = (r: Row): IssueRecord => ({
  id: r.id,
  projectId: r.project_id,
  snapshotId: r.snapshot_id,
  kind: r.kind,
  status: r.status,
  detail: JSON.parse(r.body) as IssueRecord['detail'],
  createdAt: r.created_at,
});

/** Reconciliation issues of a project, newest first. They stay open across later snapshots. */
export function listIssues(
  db: Db,
  projectId: string,
  status: 'open' | 'all' = 'open',
): IssueRecord[] {
  return db
    .prepare(
      `SELECT * FROM issues WHERE project_id = ? ${status === 'open' ? "AND status = 'open'" : ''}
       ORDER BY created_at DESC, id DESC`,
    )
    .all<Row>(projectId)
    .map(toRecord);
}

export function getIssue(db: Db, id: string): IssueRecord | undefined {
  const r = db.prepare('SELECT * FROM issues WHERE id = ?').get<Row>(id);
  return r ? toRecord(r) : undefined;
}

export type IssueAction = { action: 'link'; fromId: string; toId: string } | { action: 'dismiss' };
export type IssueResult =
  | { ok: true; issue: IssueRecord; aliases: number }
  | { ok: false; status: 404 | 409 | 400; error: string };

/**
 * A person resolves a rename issue (plan §9: ambiguous renames are never merged automatically).
 * `link` records a user-accepted alias old -> new. Pins, notes and remembered positions follow it
 * when read, and human claims follow it from the next scan. Child symbols with the same kind and
 * name follow their module when the snapshots that hold them are still stored. The issue resolves
 * once every old file is linked. `dismiss` closes it without linking.
 */
export function resolveIssue(db: Db, issueId: string, a: IssueAction): IssueResult {
  const issue = getIssue(db, issueId);
  if (!issue) return { ok: false, status: 404, error: 'unknown_issue' };
  if (issue.status !== 'open') return { ok: false, status: 409, error: `issue is ${issue.status}` };
  const now = new Date().toISOString();
  if (a.action === 'dismiss') {
    db.prepare("UPDATE issues SET status = 'dismissed', body = ? WHERE id = ?").run(
      JSON.stringify({ ...issue.detail, dismissedAt: now }),
      issue.id,
    );
    return { ok: true, issue: getIssue(db, issue.id)!, aliases: 0 };
  }
  const fromIds = issue.detail.fromIds ?? [];
  const toIds = issue.detail.toIds ?? [];
  if (!fromIds.length || !toIds.length)
    return {
      ok: false,
      status: 409,
      error: 'this issue predates linkable candidates; dismiss it and rescan',
    };
  if (!fromIds.includes(a.fromId) || !toIds.includes(a.toId))
    return { ok: false, status: 400, error: 'fromId and toId must be candidates of this issue' };
  const links = issue.detail.links ?? [];
  if (links.some((l) => l.fromId === a.fromId || l.toId === a.toId))
    return { ok: false, status: 409, error: 'already linked' };

  const insAlias = db.prepare(
    "INSERT OR REPLACE INTO entity_aliases (project_id, old_id, new_id, method, snapshot_id, created_at) VALUES (?, ?, ?, 'user-accepted', ?, ?)",
  );
  let aliases = 0;
  db.transaction(() => {
    insAlias.run(issue.projectId, a.fromId, a.toId, issue.snapshotId, now);
    aliases++;
    // children follow their module when both sides are still stored
    const prevId = db
      .prepare('SELECT previous_snapshot_id AS p FROM snapshots WHERE id = ?')
      .get<{ p: string | null }>(issue.snapshotId)?.p;
    if (prevId) {
      const kids = (snap: string, owner: string) =>
        db
          .prepare(
            'SELECT id, kind, display_name AS name FROM entities WHERE snapshot_id = ? AND owner_entity_id = ?',
          )
          .all<{ id: string; kind: string; name: string }>(snap, owner);
      const newKids = kids(issue.snapshotId, a.toId);
      for (const o of kids(prevId, a.fromId)) {
        const match = newKids.filter((n) => n.kind === o.kind && n.name === o.name);
        if (match.length === 1 && match[0]!.id !== o.id) {
          insAlias.run(issue.projectId, o.id, match[0]!.id, issue.snapshotId, now);
          aliases++;
        }
      }
    }
    const nextLinks = [...links, { fromId: a.fromId, toId: a.toId, at: now }];
    const done = fromIds.every((id) => nextLinks.some((l) => l.fromId === id));
    db.prepare('UPDATE issues SET status = ?, body = ? WHERE id = ?').run(
      done ? 'resolved' : 'open',
      JSON.stringify({ ...issue.detail, links: nextLinks }),
      issue.id,
    );
  });
  return { ok: true, issue: getIssue(db, issue.id)!, aliases };
}
