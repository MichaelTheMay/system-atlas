import type { Node as TsNode } from 'web-tree-sitter';
import { createParser } from '../parsers.ts';
import type { AnalyzerOutput, EvidenceRef } from '../types.ts';
import { dirOf, nearestPackageDir, ownerKeyFor } from '../shared/packages.ts';
import { looksLikeSql, sqlTableRefs } from '../shared/sql.ts';

/**
 * Go extraction (worker): tree-sitter syntax plus explicit rules. A Go package (directory) is the
 * module; its files are evidence. Imports resolve by module path from go.mod; stdlib is skipped;
 * third-party imports map to the longest `require` of the nearest go.mod (exact) or, if none
 * matches, to the import path's first three segments (heuristic). No type checking.
 */
export interface GoInput {
  files: { path: string; text: string; sha256: string; role: string }[];
  gomods: { path: string; text: string }[];
  manifestDirs: string[];
}

export const goModuleKey = (dir: string) => `go:module:${dir || '.'}`;

const ROUTE_METHODS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  Head: 'HEAD',
  Options: 'OPTIONS',
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  HandleFunc: 'ANY',
  Handle: 'ANY',
  Any: 'ANY',
};
const ROUTER_LIBS = [
  'net/http',
  'github.com/go-chi/chi',
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gorilla/mux',
];
const SQL_CALLS = new Set([
  'Query',
  'QueryRow',
  'QueryContext',
  'QueryRowContext',
  'Exec',
  'ExecContext',
  'Prepare',
  'PrepareContext',
  'Get',
  'Select',
  'NamedExec',
]);

const exported = (name: string) => /^\p{Lu}/u.test(name);
const unquote = (n: TsNode | null | undefined) =>
  n && (n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal')
    ? n.text.slice(1, -1)
    : undefined;

export async function extractGo(input: GoInput): Promise<AnalyzerOutput> {
  const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
  const parser = await createParser('go');
  const mods = input.gomods.map((g) => ({
    dir: dirOf(g.path),
    module: /^module\s+(\S+)/m.exec(g.text)?.[1] ?? '',
    requires: [
      ...g.text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+v[\w.+-]+/gim),
    ].map((m) => m[1]!),
  }));
  const modFor = (dir: string) =>
    mods
      .filter((m) => m.dir === '' || dir === m.dir || dir.startsWith(`${m.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  const byDir = new Map<string, GoInput['files']>();
  for (const f of input.files) byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f]);
  const externals = new Map<string, EvidenceRef>();

  for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const key = goModuleKey(dir);
    const mod = modFor(dir);
    const importPath = mod
      ? dir === mod.dir
        ? mod.module
        : `${mod.module}/${dir.slice(mod.dir ? mod.dir.length + 1 : 0)}`
      : dir;
    const pkgDir = nearestPackageDir(`${dir}/x`, input.manifestDirs) ?? '';
    let pkgName = '';
    let hasMain = false;
    const allTests = files.every((f) => f.path.endsWith('_test.go'));
    const seenImports = new Set<string>();
    const relations: AnalyzerOutput['relations'] = [];
    const symbols: AnalyzerOutput['entities'] = [];
    const endpoints = new Map<
      string,
      { method: string; path: string; ev: EvidenceRef; confidence: 'resolved' | 'heuristic' }
    >();
    const evidence: EvidenceRef[] = [];

    for (const f of files) {
      const tree = parser.parse(f.text);
      if (!tree) continue;
      const root = tree.rootNode;
      const lines = f.text.split('\n');
      const isTest = f.path.endsWith('_test.go');
      evidence.push({ path: f.path, contentHash: f.sha256, startLine: 1, endLine: lines.length });
      out.handled.push({ path: f.path, support: 'syntax' });
      if (root.hasError)
        out.diagnostics.push({
          severity: 'warning',
          code: 'go-syntax-error',
          message: 'tree-sitter reported syntax errors; results may be incomplete',
          path: f.path,
        });
      const ev = (n: TsNode): EvidenceRef => ({
        path: f.path,
        contentHash: f.sha256,
        startLine: n.startPosition.row + 1,
        endLine: n.endPosition.row + 1,
        excerpt: lines
          .slice(n.startPosition.row, Math.min(n.endPosition.row + 1, n.startPosition.row + 3))
          .join('\n')
          .slice(0, 400),
      });
      const fileImports = new Set<string>();
      for (const st of root.namedChildren) {
        if (!st) continue;
        if (st.type === 'package_clause' && !isTest) pkgName = st.namedChildren[0]?.text ?? pkgName;
        if (st.type === 'import_declaration') {
          for (const spec of st.descendantsOfType('import_spec')) {
            const p = unquote(spec?.childForFieldName('path'));
            if (!p || !spec) continue;
            fileImports.add(p);
            if (isTest) continue;
            const first = p.split('/')[0]!;
            if (!first.includes('.')) continue; // standard library
            if (mod && (p === mod.module || p.startsWith(`${mod.module}/`))) {
              const target = mod.dir
                ? `${mod.dir}/${p.slice(mod.module.length + 1)}`
                : p.slice(mod.module.length + 1);
              const tKey = byDir.has(target) ? goModuleKey(target) : `unresolved:${p}`;
              if (seenImports.has(tKey) || target === dir) continue;
              seenImports.add(tKey);
              relations.push({
                fromKey: key,
                toKey: tKey,
                kind: 'imports',
                confidence: 'resolved',
                resolved: byDir.has(target),
                evidence: [ev(spec)],
              });
              continue;
            }
            const req = mod?.requires
              .filter((r) => p === r || p.startsWith(`${r}/`))
              .sort((a, b) => b.length - a.length)[0];
            const name = req ?? p.split('/').slice(0, 3).join('/');
            const tKey = `ext:go:${name}`;
            if (!externals.has(tKey)) externals.set(tKey, ev(spec));
            if (seenImports.has(tKey)) continue;
            seenImports.add(tKey);
            relations.push({
              fromKey: key,
              toKey: tKey,
              kind: 'imports',
              confidence: req ? 'exact' : 'heuristic',
              resolved: true,
              evidence: [ev(spec)],
            });
          }
        }
        if (isTest) continue;
        const symbol = (name: string, node: TsNode, symbolKind: string) =>
          symbols.push({
            key: `go:symbol:${dir || '.'}#${name}`,
            kind: 'symbol',
            canonicalName: `go:${importPath}.${name}`,
            displayName: name,
            ownerKey: key,
            attributes: { symbolKind, exported: true, file: f.path },
            evidence: [{ ...ev(node), excerpt: lines[node.startPosition.row]?.slice(0, 300) }],
          });
        if (st.type === 'function_declaration') {
          const name = st.childForFieldName('name')?.text ?? '';
          if (name === 'main') hasMain = true;
          if (exported(name)) symbol(name, st, 'function');
        } else if (st.type === 'method_declaration') {
          const name = st.childForFieldName('name')?.text ?? '';
          const recv =
            st.childForFieldName('receiver')?.descendantsOfType('type_identifier')[0]?.text ?? '';
          if (exported(name) && exported(recv)) symbol(`${recv}.${name}`, st, 'method');
        } else if (
          st.type === 'type_declaration' ||
          st.type === 'const_declaration' ||
          st.type === 'var_declaration'
        ) {
          const kind =
            st.type === 'type_declaration'
              ? 'type'
              : st.type === 'const_declaration'
                ? 'const'
                : 'var';
          for (const spec of st.namedChildren) {
            if (!spec) continue;
            for (const n of spec.childrenForFieldName('name'))
              if (n && exported(n.text)) symbol(n.text, spec, kind);
          }
        }
      }
      if (isTest) continue;
      const routerFile = [...fileImports].some((i) =>
        ROUTER_LIBS.some((l) => i === l || i.startsWith(`${l}/`)),
      );
      for (const call of root.descendantsOfType('call_expression')) {
        const fn = call?.childForFieldName('function');
        if (!call || fn?.type !== 'selector_expression') continue;
        const field = fn.childForFieldName('field')?.text ?? '';
        const args = call.childForFieldName('arguments')?.namedChildren ?? [];
        const first = unquote(args[0]);
        if (ROUTE_METHODS[field] && first) {
          // Go 1.22 patterns may carry the method: "GET /healthz"
          const m = /^([A-Z]+)\s+(\/\S*)$/.exec(first);
          const path = m ? m[2]! : first;
          if (path.startsWith('/') && !(field === 'Handle' && path === '/')) {
            const method = m ? m[1]! : ROUTE_METHODS[field]!;
            const k = `${method} ${path}`;
            if (!endpoints.has(k))
              endpoints.set(k, {
                method,
                path,
                ev: ev(call),
                confidence: routerFile ? 'resolved' : 'heuristic',
              });
          }
        }
        if (SQL_CALLS.has(field)) {
          for (const a of args) {
            const sql = unquote(a);
            if (!sql || !looksLikeSql(sql)) continue;
            const refs = sqlTableRefs(sql);
            for (const t of refs.writes)
              relations.push({
                fromKey: key,
                toKey: `table:${t}`,
                kind: 'writes',
                confidence: 'heuristic',
                resolved: true,
                evidence: [ev(call)],
              });
            for (const t of refs.reads)
              relations.push({
                fromKey: key,
                toKey: `table:${t}`,
                kind: 'reads',
                confidence: 'heuristic',
                resolved: true,
                evidence: [ev(call)],
              });
          }
        }
      }
    }

    out.entities.push({
      key,
      kind: 'module',
      canonicalName: `go:${importPath}`,
      displayName: dir ? dir.slice(dir.lastIndexOf('/') + 1) : importPath,
      ownerKey: ownerKeyFor(`${dir}/x`, input.manifestDirs),
      attributes: {
        path: dir || '.',
        package: pkgName,
        importPath,
        files: files.length,
        test: allTests,
      },
      evidence: evidence.slice(0, 20),
    });
    out.entities.push(...symbols);
    for (const [k, e] of endpoints) {
      const eKey = `endpoint:${pkgDir || '.'}:${k}`;
      out.entities.push({
        key: eKey,
        kind: 'endpoint',
        canonicalName: k,
        displayName: k,
        ownerKey: key,
        attributes: { method: e.method, path: e.path, package: pkgDir || '.' },
        evidence: [e.ev],
      });
      relations.push({
        fromKey: key,
        toKey: eKey,
        kind: 'exposes',
        confidence: e.confidence,
        resolved: true,
        evidence: [e.ev],
      });
    }
    if (pkgName === 'main' && hasMain) {
      const name = dir ? dir.slice(dir.lastIndexOf('/') + 1) : importPath.split('/').pop()!;
      const eKey = `entry:${pkgDir || '.'}:${name}`;
      out.entities.push({
        key: eKey,
        kind: 'entrypoint',
        canonicalName: `go main ${importPath}`,
        displayName: name,
        ownerKey: ownerKeyFor(`${dir}/x`, input.manifestDirs),
        attributes: { type: 'go-main', package: importPath },
        evidence: [evidence[0]!],
      });
      relations.push({
        fromKey: eKey,
        toKey: key,
        kind: 'calls',
        confidence: 'resolved',
        resolved: true,
        evidence: [evidence[0]!],
      });
    }
    out.relations.push(...relations);
  }
  for (const [key, ev] of externals) {
    const name = key.slice('ext:go:'.length);
    out.entities.push({
      key,
      kind: 'package',
      canonicalName: `go:${name}`,
      displayName: name,
      ownerKey: 'system',
      attributes: { external: true, ecosystem: 'go' },
      evidence: [ev],
    });
  }
  return out;
}
