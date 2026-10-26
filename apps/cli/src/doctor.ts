import { existsSync, statSync } from 'node:fs';
import { access, mkdir, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AtlasPaths } from '@atlas/schema/node';
import { findDaemon } from './client.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

const MIN_NODE = [24, 21, 0];

function nodeOk(v: string): boolean {
  const parts = v.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) !== MIN_NODE[i]) return (parts[i] ?? 0) > MIN_NODE[i]!;
  }
  return true;
}

async function check(id: string, fn: () => Promise<Omit<Check, 'id'>>): Promise<Check> {
  try {
    return { id, ...(await fn()) };
  } catch (e) {
    return { id, status: 'fail', detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function runDoctor(paths: AtlasPaths): Promise<Check[]> {
  return Promise.all([
    check('node-version', async () =>
      nodeOk(process.version)
        ? { status: 'ok', detail: process.version }
        : { status: 'fail', detail: `${process.version} < v${MIN_NODE.join('.')}` },
    ),
    check('sqlite-fts5', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec(
        "create virtual table t using fts5(x); insert into t values ('architecture evidence');",
      );
      const row = db.prepare("select count(*) as n from t where t match 'evidence'").get() as {
        n: number;
      };
      const ver = db.prepare('select sqlite_version() as v').get() as { v: string };
      db.close();
      return row.n === 1
        ? { status: 'ok', detail: `node:sqlite, SQLite ${ver.v}, FTS5 available` }
        : { status: 'fail', detail: 'FTS5 query failed' };
    }),
    check('data-dir', async () => {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
      await access(paths.dataDir, constants.W_OK);
      return { status: 'ok', detail: paths.dataDir };
    }),
    check('runtime-dir-permissions', async () => {
      if (!existsSync(paths.runtimeDir))
        return { status: 'ok', detail: `${paths.runtimeDir} (not created yet)` };
      const mode = statSync(paths.runtimeDir).mode & 0o777;
      return mode & 0o077
        ? {
            status: 'fail',
            detail: `${paths.runtimeDir} is mode ${mode.toString(8)}; expected 700`,
          }
        : { status: 'ok', detail: `${paths.runtimeDir} mode 700` };
    }),
    check('tree-sitter-grammars', async () => {
      const { createParser } = await import('@atlas/analyzers');
      for (const id of ['typescript', 'tsx', 'python'] as const) {
        const tree = (await createParser(id)).parse('x = 1');
        if (!tree) throw new Error(`${id} parse returned null`);
      }
      return { status: 'ok', detail: 'typescript, tsx, python wasm grammars load' };
    }),
    check('playwright-chromium', async () => {
      try {
        const { chromium } = await import('@playwright/test');
        const exe = chromium.executablePath();
        return existsSync(exe)
          ? { status: 'ok', detail: exe }
          : {
              status: 'warn',
              detail: 'Chromium not installed; run: pnpm exec playwright install chromium',
            };
      } catch {
        return {
          status: 'warn',
          detail: 'Playwright not resolvable from this install (needed for browser capture)',
        };
      }
    }),
    check('web-ui-build', async () => {
      const dist = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
      return existsSync(dist)
        ? { status: 'ok', detail: 'apps/web/dist present; daemon serves the UI' }
        : { status: 'warn', detail: 'UI not built; run: pnpm build (or use pnpm dev)' };
    }),
    check('daemon', async () => {
      const d = await findDaemon(paths);
      return d
        ? { status: 'ok', detail: `pid ${d.rec.pid} on ${d.baseUrl}` }
        : { status: 'warn', detail: 'not running; `atlas open` or `atlas daemon start` starts it' };
    }),
  ]);
}
