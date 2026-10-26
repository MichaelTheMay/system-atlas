import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return {
        version: Number(f.slice(0, 4)),
        name: f.slice(5, -4),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  applied: number[];
  backupFile?: string;
  current: number;
}

/**
 * Applies pending migrations in order, each in its own transaction. Before touching a database
 * that already has data, writes a consistent copy with VACUUM INTO (plan §14 migration backups).
 * Refuses to run if an applied migration's file was edited (checksum mismatch).
 */
export function migrate(
  db: Db,
  opts: { backupsDir?: string; migrations?: Migration[]; now?: Date } = {},
): MigrateResult {
  const migrations = opts.migrations ?? loadMigrations();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all<{ version: number; checksum: string }>()
      .map((r) => [r.version, r.checksum]),
  );
  for (const m of migrations) {
    const sum = applied.get(m.version);
    if (sum !== undefined && sum !== m.checksum) {
      throw new Error(
        `migration ${m.version}_${m.name} was modified after being applied (checksum mismatch)`,
      );
    }
  }
  const pending = migrations.filter((m) => !applied.has(m.version));
  const current = Math.max(0, ...applied.keys());
  if (pending.length === 0) return { applied: [], current };

  let backupFile: string | undefined;
  const hasData =
    applied.size > 0 && db.path !== ':memory:' && existsSync(db.path) && statSync(db.path).size > 0;
  if (hasData && opts.backupsDir) {
    mkdirSync(opts.backupsDir, { recursive: true, mode: 0o700 });
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupFile = join(opts.backupsDir, `atlas-v${current}-${stamp}.sqlite`);
    db.prepare('VACUUM INTO ?').run(backupFile);
  }

  const done: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.name, m.checksum, new Date().toISOString());
    });
    done.push(m.version);
  }
  return { applied: done, backupFile, current: Math.max(current, ...done) };
}
