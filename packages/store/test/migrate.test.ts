import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate, openDb } from '../src/index.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'atlas-store-'));

describe('migrations', () => {
  it('applies to an empty database and re-running is a no-op', () => {
    const dir = tmp();
    const db = openDb(join(dir, 'atlas.sqlite'));
    const first = migrate(db, { backupsDir: join(dir, 'backups') });
    expect(first.applied).toEqual(loadMigrations().map((m) => m.version));
    expect(first.backupFile).toBeUndefined();
    const second = migrate(db, { backupsDir: join(dir, 'backups') });
    expect(second.applied).toEqual([]);
    expect(db.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode).toBe(
      'wal',
    );
    expect(db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys).toBe(1);
    db.close();
  });

  it('backs up an existing database before applying a new migration', () => {
    const dir = tmp();
    const db = openDb(join(dir, 'atlas.sqlite'));
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, display_name, created_at) VALUES ('proj_x', 'x', 'now')",
    ).run();
    const extra = [
      ...loadMigrations(),
      { version: 9999, name: 'extra', sql: 'CREATE TABLE extra (x INTEGER);', checksum: 'c' },
    ];
    const r = migrate(db, { backupsDir: join(dir, 'backups'), migrations: extra });
    expect(r.applied).toEqual([9999]);
    expect(r.backupFile && existsSync(r.backupFile)).toBe(true);
    const backup = openDb(r.backupFile!);
    expect(backup.prepare('SELECT count(*) AS n FROM projects').get<{ n: number }>()!.n).toBe(1);
    backup.close();
    db.close();
  });

  it('refuses to run when an applied migration was edited', () => {
    const db = openDb(':memory:');
    const ms = loadMigrations();
    migrate(db, { migrations: ms });
    const edited = ms.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    expect(() => migrate(db, { migrations: edited })).toThrow(/modified/);
  });

  it('rolls back a failing migration completely', () => {
    const db = openDb(':memory:');
    const bad = [
      {
        version: 1,
        name: 'bad',
        sql: 'CREATE TABLE ok (x INTEGER); CREATE TABLE ok (x INTEGER);',
        checksum: 'c',
      },
    ];
    expect(() => migrate(db, { migrations: bad })).toThrow();
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok'").get<{ n: number }>()!
        .n,
    ).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get<{ n: number }>()!.n).toBe(
      0,
    );
  });
});

describe('schema invariants', () => {
  it('events are append-only and deduplicated per producer', () => {
    const db = openDb(':memory:');
    migrate(db);
    const ins = db.prepare(
      `INSERT INTO events (id, producer_id, producer_event_id, run_id, type, occurred_at, received_at, body)
       VALUES (?, 'p', ?, 'run_1', 'run.started', 'now', 'now', '{}')`,
    );
    ins.run('evt_1', 'e1');
    expect(() => ins.run('evt_2', 'e1')).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('entity search uses FTS5 with path-friendly tokens', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      'INSERT INTO entity_search (snapshot_id, entity_id, kind, canonical_name, display_name) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'snap_1',
      'ent_1',
      'module',
      'ts:module:packages/api/src/routes/reports.ts',
      'reports.ts',
    );
    const hit = db
      .prepare('SELECT entity_id FROM entity_search WHERE entity_search MATCH \'"reports.ts"\'')
      .all();
    expect(hit).toHaveLength(1);
  });
});

describe('Db.transaction', () => {
  it('rejects async callbacks and rolls back', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      db.transaction(async () => {
        db.exec('INSERT INTO t VALUES (1)');
      }),
    ).toThrow(/synchronous/);
    expect(db.prepare('SELECT count(*) AS n FROM t').get<{ n: number }>()!.n).toBe(0);
  });
});
