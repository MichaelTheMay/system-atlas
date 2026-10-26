import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Thin persistence interface (ADR-0003). Everything above this file depends only on `Db`,
 * so the driver (node:sqlite today) can be swapped without touching repositories.
 */
export type SqlParam = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Statement {
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Row>(...params: SqlParam[]): T | undefined;
  all<T = Row>(...params: SqlParam[]): T[];
}

export interface Db {
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT; rolls back on throw. Nested calls join the outer
   * transaction. `fn` must be synchronous: an async callback would commit before its awaits run.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  const cache = new Map<string, Statement>();
  let depth = 0;

  return {
    path,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) {
        const s = raw.prepare(sql);
        st = {
          run: (...p) => s.run(...p) as { changes: number; lastInsertRowid: number | bigint },
          get: <T>(...p: SqlParam[]) => s.get(...p) as T | undefined,
          all: <T>(...p: SqlParam[]) => s.all(...p) as T[],
        };
        cache.set(sql, st);
      }
      return st;
    },
    transaction(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        if (out && typeof (out as { then?: unknown }).then === 'function') {
          throw new Error(
            'Db.transaction callbacks must be synchronous; do async work before the transaction',
          );
        }
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

export const json = (v: unknown): string => JSON.stringify(v);
export const parseJson = <T>(v: unknown): T => JSON.parse(String(v)) as T;
