/**
 * Snapshot reconciliation (plan §9): what changed between the previous published snapshot and the
 * new graph, which disappearances are renames, and which rename candidates need a human.
 *
 * Identity precedence: stable keys (language-qualified names) give the same ID across scans, so most
 * entities need no matching at all. Renames are only accepted on exact evidence (identical file
 * content moved, exactly one candidate). Anything weaker is recorded as an open issue, never merged.
 */

export interface EntityRow {
  id: string;
  kind: string;
  canonicalName: string;
  displayName: string;
  ownerEntityId?: string;
  lifecycle: string;
  attributes: Record<string, unknown>;
}

export interface RelationRow {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  status: string;
  evidenceIds: string[];
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'renamed' | 'stale' | 'restored';

export interface Change {
  target: 'entity' | 'relation';
  id: string;
  change: ChangeKind;
  previousId?: string;
  detail: Record<string, unknown>;
}

export interface Alias {
  oldId: string;
  newId: string;
  method: 'content-hash' | 'parent-rename';
}

export interface Issue {
  kind: 'ambiguous-rename' | 'possible-rename';
  detail: Record<string, unknown>;
}

export interface ReconcileResult {
  changes: Change[];
  aliases: Alias[];
  issues: Issue[];
  summary: {
    entities: Record<ChangeKind, number>;
    relations: Record<ChangeKind, number>;
    issues: number;
    previousSnapshotId?: string;
  };
}

const VOLATILE_ATTRS = new Set(['evidenceIds', 'lines']);

function semanticSignature(e: EntityRow): string {
  const attrs = Object.fromEntries(
    Object.entries(e.attributes)
      .filter(([k]) => !VOLATILE_ATTRS.has(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify([e.kind, e.canonicalName, e.displayName, e.ownerEntityId ?? null, attrs]);
}

const emptyCounts = (): Record<ChangeKind, number> => ({
  added: 0,
  removed: 0,
  changed: 0,
  renamed: 0,
  stale: 0,
  restored: 0,
});
const pathOf = (e: EntityRow) =>
  typeof e.attributes.path === 'string' ? e.attributes.path : undefined;
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function reconcile(args: {
  previousSnapshotId?: string;
  prevEntities: EntityRow[];
  prevRelations: RelationRow[];
  prevFiles: Map<string, string>;
  nextEntities: EntityRow[];
  nextRelations: RelationRow[];
  nextFiles: Map<string, string>;
}): ReconcileResult {
  const changes: Change[] = [];
  const aliases: Alias[] = [];
  const issues: Issue[] = [];
  const prev = new Map(args.prevEntities.map((e) => [e.id, e]));
  const next = new Map(args.nextEntities.map((e) => [e.id, e]));

  if (!args.previousSnapshotId) {
    return {
      changes,
      aliases,
      issues,
      summary: { entities: emptyCounts(), relations: emptyCounts(), issues: 0 },
    };
  }

  const removed = args.prevEntities.filter((e) => !next.has(e.id));
  const added = args.nextEntities.filter((e) => !prev.has(e.id));

  // 1. Exact-content module moves.
  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();
  const byHash = new Map<string, { gone: EntityRow[]; came: EntityRow[] }>();
  for (const e of removed) {
    const p = pathOf(e);
    const h = p && !args.nextFiles.has(p) ? args.prevFiles.get(p) : undefined;
    if (e.kind === 'module' && h)
      (byHash.get(h) ?? byHash.set(h, { gone: [], came: [] }).get(h)!).gone.push(e);
  }
  for (const e of added) {
    const p = pathOf(e);
    const h = p && !args.prevFiles.has(p) ? args.nextFiles.get(p) : undefined;
    if (e.kind === 'module' && h && byHash.has(h)) byHash.get(h)!.came.push(e);
  }
  for (const [hash, { gone, came }] of byHash) {
    if (gone.length === 0 || came.length === 0) continue;
    if (gone.length === 1 && came.length === 1) {
      aliases.push({ oldId: gone[0]!.id, newId: came[0]!.id, method: 'content-hash' });
      renamedOld.add(gone[0]!.id);
      renamedNew.add(came[0]!.id);
    } else {
      issues.push({
        kind: 'ambiguous-rename',
        detail: {
          contentHash: hash,
          from: gone.map((e) => pathOf(e)),
          to: came.map((e) => pathOf(e)),
          // entity ids, so a person can link a pair later even after the old snapshot is compacted
          fromIds: gone.map((e) => e.id),
          toIds: came.map((e) => e.id),
          reason: 'identical content matches several files; not merged',
        },
      });
    }
  }

  // 2. Children of renamed modules with the same kind and name follow their parent.
  const parentAlias = new Map(aliases.map((a) => [a.oldId, a.newId]));
  for (const e of removed) {
    if (renamedOld.has(e.id) || !e.ownerEntityId || !parentAlias.has(e.ownerEntityId)) continue;
    const newOwner = parentAlias.get(e.ownerEntityId)!;
    const match = added.filter(
      (a) =>
        !renamedNew.has(a.id) &&
        a.ownerEntityId === newOwner &&
        a.kind === e.kind &&
        a.displayName === e.displayName,
    );
    if (match.length === 1) {
      aliases.push({ oldId: e.id, newId: match[0]!.id, method: 'parent-rename' });
      renamedOld.add(e.id);
      renamedNew.add(match[0]!.id);
    }
  }

  // 3. Same file name moved with different content: a candidate for a human, never merged.
  const byBase = new Map<string, { gone: EntityRow[]; came: EntityRow[] }>();
  for (const e of removed) {
    const p = pathOf(e);
    if (e.kind === 'module' && p && !renamedOld.has(e.id))
      (
        byBase.get(baseName(p)) ?? byBase.set(baseName(p), { gone: [], came: [] }).get(baseName(p))!
      ).gone.push(e);
  }
  for (const e of added) {
    const p = pathOf(e);
    if (e.kind === 'module' && p && !renamedNew.has(e.id) && byBase.has(baseName(p)))
      byBase.get(baseName(p))!.came.push(e);
  }
  for (const [base, { gone, came }] of byBase) {
    if (gone.length && came.length) {
      issues.push({
        kind: 'possible-rename',
        detail: {
          name: base,
          from: gone.map((e) => pathOf(e)),
          to: came.map((e) => pathOf(e)),
          fromIds: gone.map((e) => e.id),
          toIds: came.map((e) => e.id),
          reason: 'same file name, different content; review before linking',
        },
      });
    }
  }

  for (const a of aliases)
    changes.push({
      target: 'entity',
      id: a.newId,
      change: 'renamed',
      previousId: a.oldId,
      detail: {
        method: a.method,
        from: prev.get(a.oldId)?.canonicalName,
        to: next.get(a.newId)?.canonicalName,
      },
    });
  for (const e of added)
    if (!renamedNew.has(e.id))
      changes.push({
        target: 'entity',
        id: e.id,
        change: 'added',
        detail: { kind: e.kind, canonicalName: e.canonicalName },
      });
  for (const e of removed) {
    if (renamedOld.has(e.id)) continue;
    // tombstone: last known shape, so a removed state can be shown during change review
    changes.push({
      target: 'entity',
      id: e.id,
      change: 'removed',
      detail: {
        kind: e.kind,
        canonicalName: e.canonicalName,
        displayName: e.displayName,
        ownerEntityId: e.ownerEntityId ?? null,
      },
    });
  }
  for (const e of args.nextEntities) {
    const p = prev.get(e.id);
    if (!p) continue;
    if (p.lifecycle !== 'stale' && e.lifecycle === 'stale')
      changes.push({
        target: 'entity',
        id: e.id,
        change: 'stale',
        detail: { canonicalName: e.canonicalName },
      });
    else if (p.lifecycle === 'stale' && e.lifecycle === 'active')
      changes.push({
        target: 'entity',
        id: e.id,
        change: 'restored',
        detail: { canonicalName: e.canonicalName },
      });
    else {
      const fields: string[] = [];
      if (semanticSignature(p) !== semanticSignature(e)) fields.push('semantic');
      if (
        JSON.stringify(p.attributes.evidenceIds ?? []) !==
        JSON.stringify(e.attributes.evidenceIds ?? [])
      )
        fields.push('evidence');
      if (fields.length)
        changes.push({
          target: 'entity',
          id: e.id,
          change: 'changed',
          detail: { canonicalName: e.canonicalName, fields },
        });
    }
  }

  const prevRel = new Map(args.prevRelations.map((r) => [r.id, r]));
  const nextRel = new Map(args.nextRelations.map((r) => [r.id, r]));
  for (const r of args.nextRelations) {
    const p = prevRel.get(r.id);
    if (!p)
      changes.push({
        target: 'relation',
        id: r.id,
        change: 'added',
        detail: { kind: r.kind, fromId: r.fromId, toId: r.toId },
      });
    else if (p.status !== 'stale' && r.status === 'stale')
      changes.push({ target: 'relation', id: r.id, change: 'stale', detail: { kind: r.kind } });
    else if (p.status === 'stale' && r.status !== 'stale')
      changes.push({ target: 'relation', id: r.id, change: 'restored', detail: { kind: r.kind } });
    else {
      const fields: string[] = [];
      if (p.status !== r.status) fields.push('status');
      if (JSON.stringify(p.evidenceIds) !== JSON.stringify(r.evidenceIds)) fields.push('evidence');
      if (fields.length)
        changes.push({
          target: 'relation',
          id: r.id,
          change: 'changed',
          detail: { kind: r.kind, fields, status: [p.status, r.status] },
        });
    }
  }
  for (const r of args.prevRelations) {
    if (!nextRel.has(r.id))
      changes.push({
        target: 'relation',
        id: r.id,
        change: 'removed',
        detail: { kind: r.kind, fromId: r.fromId, toId: r.toId },
      });
  }

  const summary = {
    entities: emptyCounts(),
    relations: emptyCounts(),
    issues: issues.length,
    previousSnapshotId: args.previousSnapshotId,
  };
  for (const c of changes) summary[c.target === 'entity' ? 'entities' : 'relations'][c.change]++;
  return { changes, aliases, issues, summary };
}
