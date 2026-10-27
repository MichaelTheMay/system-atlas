import type { Node as TsNode } from 'web-tree-sitter';
import { createParser } from '../parsers.ts';
import type { AnalyzerOutput, EvidenceRef } from '../types.ts';
import { nearestPackageDir, ownerKeyFor } from '../shared/packages.ts';
import { looksLikeSql, sqlTableRefs } from '../shared/sql.ts';

/**
 * Java extraction (worker): tree-sitter syntax plus explicit rules. One module per source file,
 * named by its package and primary type. Single-type and wildcard imports resolve against the
 * project's own types; JDK packages are skipped; other imports map to the longest group id
 * declared in a pom.xml or Gradle build (exact) or to their first two segments (heuristic).
 * Same-package references (which need no import) and reflection are not followed.
 */
export interface JavaInput {
  files: { path: string; text: string; sha256: string; role: string }[];
  builds: { path: string; text: string }[];
  manifestDirs: string[];
}

export const javaModuleKey = (path: string) => `java:module:${path}`;

const JDK = /^(java|javax|jdk|sun|com\.sun)\./;
const SPRING_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};
const JAXRS_HTTP = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const SQL_CALLS = new Set([
  'query',
  'queryForObject',
  'queryForList',
  'queryForMap',
  'update',
  'batchUpdate',
  'execute',
  'executeQuery',
  'executeUpdate',
  'prepareStatement',
  'createNativeQuery',
]);

const str = (n: TsNode | null | undefined): string | undefined => {
  if (!n || n.type !== 'string_literal') return undefined;
  const t = n.text;
  return t.startsWith('"""') ? t.slice(3, -3).trim() : t.slice(1, -1);
};

/** Annotation name and arguments: the bare literal, named elements (value/path/method/nativeQuery…). */
function annotations(node: TsNode | null | undefined) {
  const mods = node?.namedChildren.find((c) => c?.type === 'modifiers');
  const out: { name: string; value?: string; elements: Record<string, TsNode> }[] = [];
  for (const a of mods?.namedChildren ?? []) {
    if (!a || (a.type !== 'annotation' && a.type !== 'marker_annotation')) continue;
    const name = (a.childForFieldName('name')?.text ?? '').split('.').pop()!;
    const args = a.childForFieldName('arguments');
    const elements: Record<string, TsNode> = {};
    let value: string | undefined;
    for (const arg of args?.namedChildren ?? []) {
      if (!arg) continue;
      if (arg.type === 'element_value_pair') {
        const k = arg.childForFieldName('key')?.text ?? '';
        const v = arg.childForFieldName('value');
        if (v) elements[k] = v;
      } else value ??= str(arg) ?? str(arg.namedChildren.find((c) => c?.type === 'string_literal'));
    }
    const first = (k: string) => {
      const v = elements[k];
      return str(v) ?? str(v?.namedChildren.find((c) => c?.type === 'string_literal'));
    };
    out.push({ name, value: value ?? first('value') ?? first('path'), elements });
  }
  return out;
}

const joinPath = (a: string, b: string) => {
  const p = `/${[a, b]
    .map((x) => x.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;
  return p;
};

export async function extractJava(input: JavaInput): Promise<AnalyzerOutput> {
  const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
  const parser = await createParser('java');
  const groups = [
    ...new Set(
      input.builds.flatMap((b) => [
        ...[...b.text.matchAll(/<groupId>\s*([\w.-]+)\s*<\/groupId>/g)].map((m) => m[1]!),
        ...[...b.text.matchAll(/["']([\w.-]+):[\w.-]+(?::[^"']*)?["']/g)].map((m) => m[1]!),
      ]),
    ),
  ];
  const parsed = input.files.map((f) => {
    const tree = parser.parse(f.text);
    const root = tree?.rootNode;
    const pkg =
      root?.namedChildren.find((c) => c?.type === 'package_declaration')?.namedChildren[0]?.text ??
      '';
    const types = (root?.namedChildren ?? []).filter(
      (c): c is TsNode =>
        !!c && /^(class|interface|enum|record|annotation_type)_declaration$/.test(c.type),
    );
    const isPublic = (n: TsNode) =>
      /\bpublic\b/.test(n.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '');
    const primary = types.find(isPublic) ?? types[0];
    const typeName =
      primary?.childForFieldName('name')?.text ??
      f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.java$/, '');
    return { f, root, pkg, types, primary, typeName, isPublic };
  });
  const byFqcn = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const p of parsed) {
    for (const t of p.types) {
      const n = t.childForFieldName('name')?.text;
      if (n) byFqcn.set(p.pkg ? `${p.pkg}.${n}` : n, p.f.path);
    }
    byPackage.set(p.pkg, [...(byPackage.get(p.pkg) ?? []), p.f.path]);
  }
  const externals = new Map<string, EvidenceRef>();

  for (const { f, root, pkg, types, typeName, isPublic } of parsed) {
    if (!root) continue;
    const key = javaModuleKey(f.path);
    const lines = f.text.split('\n');
    const pkgDir = nearestPackageDir(f.path, input.manifestDirs) ?? '';
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
    out.entities.push({
      key,
      kind: 'module',
      canonicalName: `java:${pkg ? `${pkg}.` : ''}${typeName}`,
      displayName: typeName,
      ownerKey: ownerKeyFor(f.path, input.manifestDirs),
      attributes: { path: f.path, package: pkg, lines: lines.length, test: f.role === 'test' },
      evidence: [{ path: f.path, contentHash: f.sha256, startLine: 1, endLine: lines.length }],
    });
    out.handled.push({ path: f.path, support: 'syntax' });
    if (root.hasError)
      out.diagnostics.push({
        severity: 'warning',
        code: 'java-syntax-error',
        message: 'tree-sitter reported syntax errors; results may be incomplete',
        path: f.path,
      });

    const seen = new Set<string>();
    const imported: string[] = [];
    const link = (
      toKey: string,
      node: TsNode,
      confidence: 'resolved' | 'exact' | 'heuristic',
      resolved = true,
    ) => {
      if (seen.has(toKey) || toKey === key) return;
      seen.add(toKey);
      out.relations.push({
        fromKey: key,
        toKey,
        kind: 'imports',
        confidence,
        resolved,
        evidence: [ev(node)],
      });
    };
    for (const imp of root.namedChildren) {
      if (!imp || imp.type !== 'import_declaration') continue;
      const isStatic =
        imp.namedChildren.some((c) => c?.type === 'static') || /^import\s+static\b/.test(imp.text);
      const wildcard = imp.namedChildren.some((c) => c?.type === 'asterisk');
      let name =
        imp.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier')
          ?.text ?? '';
      if (!name) continue;
      imported.push(name);
      if (JDK.test(`${name}.`)) continue;
      if (isStatic && !wildcard) name = name.slice(0, name.lastIndexOf('.'));
      if (wildcard && byPackage.has(name)) {
        for (const p of byPackage.get(name)!.slice(0, 20)) link(javaModuleKey(p), imp, 'resolved');
        continue;
      }
      // static imports name a class or a member: walk up to the longest known class
      let cls = name;
      while (cls.includes('.') && !byFqcn.has(cls)) cls = cls.slice(0, cls.lastIndexOf('.'));
      if (byFqcn.has(cls)) {
        link(javaModuleKey(byFqcn.get(cls)!), imp, 'resolved');
        continue;
      }
      const group = groups
        .filter((g) => name === g || name.startsWith(`${g}.`))
        .sort((a, b) => b.length - a.length)[0];
      const ext = `ext:maven:${group ?? name.split('.').slice(0, 2).join('.')}`;
      if (!externals.has(ext)) externals.set(ext, ev(imp));
      link(ext, imp, group ? 'exact' : 'heuristic');
    }

    const webFile = imported.some(
      (i) =>
        i.startsWith('org.springframework.web') ||
        i.startsWith('jakarta.ws.rs') ||
        i.startsWith('javax.ws.rs'),
    );
    for (const t of types) {
      const tName = t.childForFieldName('name')?.text ?? typeName;
      const tAnns = annotations(t);
      const prefix =
        tAnns.find((a) => a.name === 'RequestMapping' || a.name === 'Path')?.value ?? '';
      const body = t.childForFieldName('body');
      const iface = t.type === 'interface_declaration';
      for (const m of body?.namedChildren ?? []) {
        if (!m || m.type !== 'method_declaration') continue;
        const mName = m.childForFieldName('name')?.text ?? '';
        const mods = m.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '';
        if (
          f.role !== 'test' &&
          isPublic(t) &&
          (iface || /\bpublic\b/.test(mods)) &&
          !seen.has(`sym:${tName}.${mName}`)
        ) {
          seen.add(`sym:${tName}.${mName}`);
          out.entities.push({
            key: `java:symbol:${f.path}#${tName}.${mName}`,
            kind: 'symbol',
            canonicalName: `java:${pkg ? `${pkg}.` : ''}${tName}.${mName}`,
            displayName: `${tName}.${mName}`,
            ownerKey: key,
            attributes: { symbolKind: 'method', exported: true },
            evidence: [{ ...ev(m), excerpt: lines[m.startPosition.row]?.slice(0, 300) }],
          });
        }
        if (mName === 'main' && /\bstatic\b/.test(mods) && /\bpublic\b/.test(mods)) {
          const eKey = `entry:${pkgDir || '.'}:${tName}`;
          out.entities.push({
            key: eKey,
            kind: 'entrypoint',
            canonicalName: `java main ${pkg ? `${pkg}.` : ''}${tName}`,
            displayName: tName,
            ownerKey: ownerKeyFor(f.path, input.manifestDirs),
            attributes: { type: 'java-main' },
            evidence: [ev(m)],
          });
          out.relations.push({
            fromKey: eKey,
            toKey: key,
            kind: 'calls',
            confidence: 'resolved',
            resolved: true,
            evidence: [ev(m)],
          });
        }
        // Spring MVC and JAX-RS endpoint declarations
        const anns = annotations(m);
        let method: string | undefined;
        let path: string | undefined;
        for (const a of anns) {
          if (SPRING_HTTP[a.name]) {
            method = SPRING_HTTP[a.name];
            path = a.value ?? '';
          } else if (a.name === 'RequestMapping') {
            method =
              a.elements.method?.text
                .split('.')
                .pop()
                ?.replace(/[^A-Z]/g, '') || 'ANY';
            path = a.value ?? '';
          } else if (JAXRS_HTTP.has(a.name)) {
            method = a.name;
            path ??= '';
          } else if (a.name === 'Path') path = a.value ?? '';
        }
        if (method && path !== undefined) {
          const full = joinPath(prefix, path);
          const k = `${method} ${full}`;
          const eKey = `endpoint:${pkgDir || '.'}:${k}`;
          out.entities.push({
            key: eKey,
            kind: 'endpoint',
            canonicalName: k,
            displayName: k,
            ownerKey: key,
            attributes: { method, path: full, package: pkgDir || '.' },
            evidence: [ev(m)],
          });
          out.relations.push({
            fromKey: key,
            toKey: eKey,
            kind: 'exposes',
            confidence: webFile ? 'resolved' : 'heuristic',
            resolved: true,
            evidence: [ev(m)],
          });
        }
        // Spring Data @Query with literal SQL
        const q = anns.find((a) => a.name === 'Query')?.value;
        if (q && looksLikeSql(q)) sql(q, m);
      }
    }
    for (const call of root.descendantsOfType('method_invocation')) {
      if (!call) continue;
      const name = call.childForFieldName('name')?.text ?? '';
      if (!SQL_CALLS.has(name)) continue;
      for (const a of call.childForFieldName('arguments')?.namedChildren ?? []) {
        const s = str(a);
        if (s && looksLikeSql(s)) sql(s, call);
      }
    }
    function sql(text: string, node: TsNode) {
      const refs = sqlTableRefs(text);
      for (const t of refs.writes)
        out.relations.push({
          fromKey: key,
          toKey: `table:${t}`,
          kind: 'writes',
          confidence: 'heuristic',
          resolved: true,
          evidence: [ev(node)],
        });
      for (const t of refs.reads)
        out.relations.push({
          fromKey: key,
          toKey: `table:${t}`,
          kind: 'reads',
          confidence: 'heuristic',
          resolved: true,
          evidence: [ev(node)],
        });
    }
  }
  for (const [key, ev] of externals) {
    const name = key.slice('ext:maven:'.length);
    out.entities.push({
      key,
      kind: 'package',
      canonicalName: `maven:${name}`,
      displayName: name,
      ownerKey: 'system',
      attributes: { external: true, ecosystem: 'maven' },
      evidence: [ev],
    });
  }
  return out;
}
