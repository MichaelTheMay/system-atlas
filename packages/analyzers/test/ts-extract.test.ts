import { describe, expect, it } from 'vitest';
import { extractTs, sqlCreatedTables, sqlTableRefs } from '../src/index.ts';

const file = (path: string, text: string) => ({
  path,
  text,
  sha256: 'a'.repeat(64),
  role: 'source',
});
const rels = (o: ReturnType<typeof extractTs>, kind?: string) =>
  o.relations
    .filter((r) => !kind || r.kind === kind)
    .map((r) => `${r.kind} ${r.fromKey} -> ${r.toKey}${r.resolved ? '' : ' (unresolved)'}`);

describe('extractTs', () => {
  it('resolves relative, .js-suffixed, index, tsconfig paths and workspace imports; skips builtins', () => {
    const o = extractTs({
      files: [
        file(
          'app/src/a.ts',
          "import { b } from './b.js';\nimport x from './dir';\nimport { c } from '@lib/c';\nimport fs from 'node:fs';\nimport path from 'path';\nimport { s } from 'shared';\nimport missing from './nope';\nconst lazy = await import('./b');\nexport const v = 1;",
        ),
        file('app/src/b.ts', 'export const b = 1;'),
        file('app/src/dir/index.tsx', 'export default 1;'),
        file('app/src/lib/c.ts', 'export const c = 1;'),
        file('shared/src/index.ts', 'export const s = 1;'),
      ],
      packageJsons: [
        { path: 'app/package.json', text: '{"name":"app"}' },
        {
          path: 'shared/package.json',
          text: '{"name":"shared","exports":{".":{"import":"./src/index.ts"}}}',
        },
      ],
      tsconfigs: [
        {
          path: 'app/tsconfig.json',
          text: '{ // comments allowed\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }',
        },
      ],
      manifestDirs: ['app', 'shared'],
    });
    expect(rels(o, 'imports')).toEqual([
      'imports ts:module:app/src/a.ts -> ts:module:app/src/b.ts',
      'imports ts:module:app/src/a.ts -> ts:module:app/src/dir/index.tsx',
      'imports ts:module:app/src/a.ts -> ts:module:app/src/lib/c.ts',
      'imports ts:module:app/src/a.ts -> ts:module:shared/src/index.ts',
      'imports ts:module:app/src/a.ts -> unresolved:./nope (unresolved)',
    ]);
    expect(o.entities.find((e) => e.key === 'ts:symbol:app/src/a.ts#v')).toBeTruthy();
    expect(o.entities.find((e) => e.key === 'ts:module:app/src/a.ts')?.ownerKey).toBe('pkg:app');
  });

  it('labels route declarations without a server framework as heuristic and ignores non-route calls', () => {
    const o = extractTs({
      files: [
        file(
          's.ts',
          "app.get('/a', h);\nmap.get('/not-a-route');\ncache.get('key');\nrouter.delete('/b/:id', h);",
        ),
      ],
      packageJsons: [],
      tsconfigs: [],
      manifestDirs: [],
    });
    expect(
      o.relations.filter((r) => r.kind === 'exposes').map((r) => [r.toKey, r.confidence]),
    ).toEqual([
      ['endpoint:.:GET /a', 'heuristic'],
      ['endpoint:.:DELETE /b/:id', 'heuristic'],
    ]);
  });

  it('leaves unresolvable queue names as unresolved references', () => {
    const o = extractTs({
      files: [
        file(
          'q.ts',
          "import { Queue } from 'bullmq';\nnew Queue(process.env.QUEUE_NAME!);\nnew Queue('direct');",
        ),
      ],
      packageJsons: [],
      tsconfigs: [],
      manifestDirs: [],
    });
    expect(rels(o, 'publishes')).toEqual([
      'publishes ts:module:q.ts -> unresolved:queue name process.env.QUEUE_NAME! (unresolved)',
      'publishes ts:module:q.ts -> queue:direct',
    ]);
  });
});

describe('sql helpers', () => {
  it('finds reads and writes', () => {
    expect(
      sqlTableRefs('INSERT INTO public.orders (id) SELECT id FROM carts JOIN users u ON true'),
    ).toEqual({ reads: ['carts', 'users'], writes: ['orders'] });
    expect(sqlTableRefs('DELETE FROM sessions WHERE expires < now()')).toEqual({
      reads: [],
      writes: ['sessions'],
    });
    expect(sqlTableRefs('UPDATE "Accounts" SET x = 1')).toEqual({
      reads: [],
      writes: ['accounts'],
    });
  });
  it('finds created tables and foreign keys', () => {
    expect(
      sqlCreatedTables(
        'CREATE TABLE IF NOT EXISTS a (id int);\ncreate table b (a_id int references a(id), c_id int REFERENCES c);',
      ),
    ).toEqual([
      { name: 'a', line: 1, references: [] },
      { name: 'b', line: 2, references: ['a', 'c'] },
    ]);
  });
});

describe('asset imports and virtual tables', () => {
  it('does not report style or asset imports as unresolved', () => {
    const o = extractTs({
      files: [
        file(
          'm.tsx',
          "import './styles.css';\nimport logo from './logo.svg';\nimport data from './data.json';",
        ),
      ],
      packageJsons: [],
      tsconfigs: [],
      manifestDirs: [],
    });
    expect(o.relations).toEqual([]);
  });
  it('recognizes FTS virtual tables', () => {
    expect(
      sqlCreatedTables('CREATE VIRTUAL TABLE entity_search USING fts5(name);').map((t) => t.name),
    ).toEqual(['entity_search']);
  });
});
