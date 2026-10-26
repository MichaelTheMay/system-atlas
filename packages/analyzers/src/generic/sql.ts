import type { Analyzer, AnalyzerOutput } from '../types.ts';
import { manifestDirs, ownerKeyFor } from '../shared/packages.ts';
import { sqlCreatedTables } from '../shared/sql.ts';

export const SQL_ANALYZER_ID = 'generic-sql';
export const SQL_ANALYZER_VERSION = '0.1.0';

/** Tables declared by CREATE TABLE in migration/schema SQL files, and their foreign keys. */
export function createSqlAnalyzer(): Analyzer {
  const eligible = (f: { language: string; role: string; path: string }) =>
    f.language === 'sql' &&
    (f.role === 'migration' ||
      f.role === 'schema' ||
      /(^|\/)(schema|init|ddl)[\w.-]*\.sql$/i.test(f.path));
  return {
    id: SQL_ANALYZER_ID,
    version: SQL_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some(eligible);
    },
    capabilities() {
      return {
        languages: ['sql'],
        entityKinds: ['table'],
        relationKinds: ['depends-on'],
        limitations: [
          'CREATE TABLE and inline REFERENCES only; ALTER TABLE, views, and ORM model definitions are not analyzed.',
          'Table identity is the unqualified, lower-cased name; same-named tables in different schemas or databases merge.',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter((p) =>
        p.endsWith('.sql'),
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
      const dirs = manifestDirs(files);
      const declared = new Set<string>();
      for (const f of files.filter(eligible)) {
        const text = await ctx.readFile(f.path);
        out.handled.push({ path: f.path, support: 'syntax' });
        const lines = text.split('\n');
        for (const t of sqlCreatedTables(text)) {
          const ev = {
            path: f.path,
            contentHash: f.sha256,
            startLine: t.line,
            endLine: t.line,
            excerpt: lines[t.line - 1]?.trim().slice(0, 300),
          };
          if (!declared.has(t.name)) {
            declared.add(t.name);
            out.entities.push({
              key: `table:${t.name}`,
              kind: 'table',
              canonicalName: `table:${t.name}`,
              displayName: t.name,
              ownerKey: ownerKeyFor(f.path, dirs),
              attributes: { declaredIn: f.path },
              evidence: [ev],
            });
          }
          for (const ref of t.references) {
            if (ref !== t.name)
              out.relations.push({
                fromKey: `table:${t.name}`,
                toKey: `table:${ref}`,
                kind: 'depends-on',
                qualifiers: { via: 'foreign-key' },
                confidence: 'exact',
                resolved: true,
                evidence: [ev],
              });
          }
        }
      }
      return out;
    },
  };
}
