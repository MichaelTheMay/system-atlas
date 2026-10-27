import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { registerRoot, scanWorktree, stableId } from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

interface Expected {
  fixture: string;
  entities: [string, string][];
  relations: [string, string, string][];
}

/**
 * Compares analyzer output with hand-authored expected graphs (fixtures/expected, plan §16) and
 * prints precision/recall per analyzer and relation kind. `contains` (ownership) relations are
 * excluded: ownership is checked through entity owners, not edge lists.
 */
async function evaluate(name: string) {
  const expected = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/expected/${name}.json`, import.meta.url)),
      'utf8',
    ),
  ) as Expected;
  const db = freshDb();
  const { project, worktree } = await registerRoot(db, fixture(name));
  const result = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const sid = result.snapshot.id;
  const id = (key: string) => stableId('entity', project.id, key);
  const ents = new Map(
    db
      .prepare('SELECT id, kind, canonical_name FROM entities WHERE snapshot_id = ?')
      .all<{ id: string; kind: string; canonical_name: string }>(sid)
      .map((e) => [e.id, e]),
  );
  const wantIds = new Set(expected.entities.map(([k]) => id(k)));
  const extraEntities = [...ents.values()]
    .filter((e) => !wantIds.has(e.id))
    .map((e) => `${e.kind} ${e.canonical_name}`);
  const missingEntities = expected.entities
    .filter(([k, kind]) => ents.get(id(k))?.kind !== kind)
    .map(([k, kind]) => `${kind} ${k} (got ${ents.get(id(k))?.kind ?? 'none'})`);

  const rels = db
    .prepare(
      "SELECT kind, from_id, to_id, producer, status FROM relations WHERE snapshot_id = ? AND kind != 'contains'",
    )
    .all<{ kind: string; from_id: string; to_id: string; producer: string; status: string }>(sid);
  const produced = new Map(rels.map((r) => [`${r.kind}|${r.from_id}|${r.to_id}`, r]));
  const expectedSet = new Map(
    expected.relations.map(([kind, f, t]) => [`${kind}|${id(f)}|${id(t)}`, `${kind} ${f} -> ${t}`]),
  );
  const label = (r: { kind: string; from_id: string; to_id: string }) =>
    `${r.kind} ${ents.get(r.from_id)?.canonical_name} -> ${ents.get(r.to_id)?.canonical_name}`;

  const rows = new Map<string, { tp: number; fp: number; fn: number }>();
  const row = (k: string) => rows.get(k) ?? (rows.set(k, { tp: 0, fp: 0, fn: 0 }), rows.get(k)!);
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  for (const [k, r] of produced) {
    if (expectedSet.has(k)) row(`${r.producer} ${r.kind}`).tp++;
    else {
      row(`${r.producer} ${r.kind}`).fp++;
      falsePositives.push(label(r));
    }
  }
  for (const [k, text] of expectedSet) {
    if (!produced.has(k)) {
      row(`(missed) ${k.split('|')[0]}`).fn++;
      falseNegatives.push(text);
    }
  }
  const table = [...rows.entries()].sort().map(([k, v]) => {
    const p = v.tp + v.fp ? (v.tp / (v.tp + v.fp)).toFixed(2) : '—';
    const r = v.tp + v.fn ? (v.tp / (v.tp + v.fn)).toFixed(2) : '—';
    return `${k.padEnd(34)} tp=${v.tp} fp=${v.fp} fn=${v.fn} precision=${p} recall=${r}`;
  });
  console.log(
    `\n${name} (${result.coverage.totals.files} files, snapshot ${result.snapshot.state})\n${table.join('\n')}`,
  );
  if (extraEntities.length) console.log(`unexpected entities:\n  ${extraEntities.join('\n  ')}`);
  if (missingEntities.length)
    console.log(`missing/mis-kinded entities:\n  ${missingEntities.join('\n  ')}`);
  if (falseNegatives.length) console.log(`missed relations:\n  ${falseNegatives.join('\n  ')}`);
  if (falsePositives.length) console.log(`unexpected relations:\n  ${falsePositives.join('\n  ')}`);
  return { result, extraEntities, missingEntities, falseNegatives, falsePositives, rels, db };
}

describe('analyzers vs hand-authored expected graphs', () => {
  it('ts-web-service', async () => {
    const r = await evaluate('ts-web-service');
    expect(r.result.snapshot.state).toBe('ready');
    expect(r.missingEntities).toEqual([]);
    expect(r.extraEntities).toEqual([]);
    expect(r.falseNegatives).toEqual([]);
    expect(r.falsePositives).toEqual([]);
  });

  it('py-cli-api', async () => {
    const r = await evaluate('py-cli-api');
    expect(r.result.snapshot.state).toBe('ready');
    expect(r.missingEntities).toEqual([]);
    expect(r.extraEntities).toEqual([]);
    expect(r.falseNegatives).toEqual([]);
    expect(r.falsePositives).toEqual([]);
  });

  for (const name of ['go-service', 'java-service']) {
    it(name, async () => {
      const r = await evaluate(name);
      expect(r.result.snapshot.state).toBe('ready');
      expect(r.missingEntities).toEqual([]);
      expect(r.extraEntities).toEqual([]);
      expect(r.falseNegatives).toEqual([]);
      expect(r.falsePositives).toEqual([]);
      expect(r.result.coverage.gaps).toEqual([]);
    });
  }
});
