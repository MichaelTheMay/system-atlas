import type { Node as TsNode } from 'web-tree-sitter';
import { parse as parseToml } from 'smol-toml';
import { createParser } from '../parsers.ts';
import type { AnalyzerOutput, EvidenceRef } from '../types.ts';
import { dirOf, nearestPackageDir, ownerKeyFor, packageKey } from '../shared/packages.ts';
import { looksLikeSql, sqlTableRefs } from '../shared/sql.ts';
import { PY_STDLIB } from './stdlib.ts';

/**
 * Python extraction (runs in a worker): tree-sitter syntax plus explicit, documented rules.
 * - Module names come from source roots: `<project>/src` when present, else the project dir.
 * - Imports resolve only to modules inside the registered root; stdlib is skipped; everything
 *   else is recorded as a third-party package by its top-level import name.
 * - Environment-dependent resolution (sys.path edits, namespace packages across roots, dynamic
 *   __import__) is not attempted; unresolved project imports become coverage gaps.
 */
export interface PyInput {
  files: { path: string; text: string; sha256: string; role: string }[];
  pyprojects: { path: string; text: string; sha256: string }[];
  manifestDirs: string[];
}

const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const SQL_CALLEES = new Set([
  'execute',
  'executemany',
  'executescript',
  'query',
  'raw',
  'text',
  'fetch',
  'fetchrow',
  'fetchval',
]);

export const pyModuleKey = (path: string) => `py:module:${path}`;

export async function extractPython(input: PyInput): Promise<AnalyzerOutput> {
  const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
  const parser = await createParser('python');
  const pyDirs = [...new Set(input.pyprojects.map((p) => dirOf(p.path)))];

  // Source roots and dotted names.
  const roots = new Set<string>();
  for (const d of [...pyDirs, '']) {
    const src = d ? `${d}/src` : 'src';
    if (input.files.some((f) => f.path.startsWith(`${src}/`))) roots.add(src);
    roots.add(d);
  }
  const rootOf = (p: string) =>
    [...roots]
      .filter((r) => r === '' || p.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0] ?? '';
  const dotted = new Map<string, string>(); // dotted -> path
  const nameOf = new Map<string, string>(); // path -> dotted
  for (const f of input.files) {
    const r = rootOf(f.path);
    const rel = (r ? f.path.slice(r.length + 1) : f.path).replace(/\.pyi?$/, '');
    const name = rel
      .replace(/\/__init__$/, '')
      .split('/')
      .join('.');
    if (!dotted.has(name) || f.path.endsWith('.py')) dotted.set(name, f.path);
    nameOf.set(f.path, name);
  }
  const topLevel = new Set([...dotted.keys()].map((n) => n.split('.')[0]!));
  const externals = new Map<string, EvidenceRef>();

  for (const f of input.files) {
    const tree = parser.parse(f.text);
    if (!tree) continue;
    const root = tree.rootNode;
    const key = pyModuleKey(f.path);
    const modName = nameOf.get(f.path)!;
    const lines = f.text.split('\n');
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
    const isPackageInit = /\/__init__\.pyi?$/.test(f.path);
    out.entities.push({
      key,
      kind: 'module',
      canonicalName: `py:${modName}`,
      displayName: modName.split('.').pop() || modName,
      ownerKey: ownerKeyFor(f.path, input.manifestDirs),
      attributes: {
        path: f.path,
        module: modName,
        lines: lines.length,
        test: f.role === 'test',
        mainGuard: /if\s+__name__\s*==\s*["']__main__["']/.test(f.text),
      },
      evidence: [{ path: f.path, contentHash: f.sha256, startLine: 1, endLine: lines.length }],
    });
    out.handled.push({ path: f.path, support: 'syntax' });
    if (root.hasError)
      out.diagnostics.push({
        severity: 'warning',
        code: 'python-syntax-error',
        message: 'tree-sitter reported syntax errors; results may be incomplete',
        path: f.path,
      });

    // Top-level public symbols, and app/router objects for route decorators.
    const appObjects = new Map<string, { prefix: string; framework: string }>();
    for (const st of root.namedChildren) {
      if (!st) continue;
      const def = st.type === 'decorated_definition' ? st.childForFieldName('definition') : st;
      if (def && (def.type === 'function_definition' || def.type === 'class_definition')) {
        const name = def.childForFieldName('name')?.text;
        if (name && !name.startsWith('_')) {
          out.entities.push({
            key: `py:symbol:${f.path}#${name}`,
            kind: 'symbol',
            canonicalName: `py:${modName}.${name}`,
            displayName: name,
            ownerKey: key,
            attributes: { symbolKind: def.type === 'class_definition' ? 'class' : 'function' },
            evidence: [{ ...ev(st), excerpt: lines[st.startPosition.row]?.slice(0, 300) }],
          });
        }
      }
      if (st.type === 'expression_statement') {
        const asg = st.namedChildren[0];
        if (asg?.type === 'assignment') {
          const left = asg.childForFieldName('left');
          const right = asg.childForFieldName('right');
          const fn = right?.type === 'call' ? right.childForFieldName('function')?.text : undefined;
          if (
            left?.type === 'identifier' &&
            fn &&
            /^(FastAPI|APIRouter|Flask|Blueprint|fastapi\.FastAPI|fastapi\.APIRouter|flask\.Flask)$/.test(
              fn,
            )
          ) {
            const args = right!.childForFieldName('arguments');
            let prefix = '';
            for (const a of args?.namedChildren ?? []) {
              if (
                a?.type === 'keyword_argument' &&
                /^(prefix|url_prefix)$/.test(a.childForFieldName('name')?.text ?? '')
              )
                prefix = stringValue(a.childForFieldName('value')) ?? '';
            }
            appObjects.set(left.text, { prefix, framework: fn.replace(/^\w+\./, '') });
          }
        }
      }
    }

    const seen = new Set<string>();
    const addImport = (
      target:
        | { kind: 'module'; path: string }
        | { kind: 'ext'; name: string }
        | { kind: 'unresolved'; spec: string },
      n: TsNode,
    ) => {
      if (target.kind === 'module') {
        const toKey = pyModuleKey(target.path);
        if (toKey === key || seen.has(toKey)) return;
        seen.add(toKey);
        out.relations.push({
          fromKey: key,
          toKey,
          kind: 'imports',
          confidence: 'resolved',
          resolved: true,
          evidence: [ev(n)],
        });
      } else if (target.kind === 'ext') {
        const toKey = `ext:pypi:${target.name}`;
        if (!externals.has(toKey)) externals.set(toKey, ev(n));
        if (seen.has(toKey)) return;
        seen.add(toKey);
        out.relations.push({
          fromKey: key,
          toKey,
          kind: 'imports',
          confidence: 'exact',
          resolved: true,
          evidence: [ev(n)],
        });
      } else {
        out.relations.push({
          fromKey: key,
          toKey: `unresolved:${target.spec}`,
          kind: 'imports',
          confidence: 'heuristic',
          resolved: false,
          evidence: [ev(n)],
        });
      }
    };
    const resolveAbs = (name: string) => {
      const top = name.split('.')[0]!;
      if (PY_STDLIB.has(top)) return undefined;
      const p = dotted.get(name);
      if (p) return { kind: 'module' as const, path: p };
      if (topLevel.has(top)) return { kind: 'unresolved' as const, spec: name };
      return { kind: 'ext' as const, name: top };
    };
    const pkgOf = isPackageInit ? modName : modName.split('.').slice(0, -1).join('.');

    const walk = (n: TsNode) => {
      if (n.type === 'import_statement') {
        for (const c of n.namedChildren) {
          if (!c) continue;
          const name =
            c.type === 'aliased_import'
              ? c.childForFieldName('name')?.text
              : c.type === 'dotted_name'
                ? c.text
                : undefined;
          if (!name) continue;
          // `import a.b` binds a and imports a.b: prefer the deepest project module
          const r = resolveAbs(name) ?? undefined;
          if (r) addImport(r, n);
        }
      } else if (n.type === 'import_from_statement') {
        const mod = n.childForFieldName('module_name');
        let base: string | undefined;
        if (mod?.type === 'relative_import') {
          const dots = (mod.text.match(/^\.+/)?.[0].length ?? 1) - 1;
          const parts = pkgOf ? pkgOf.split('.') : [];
          const anchor = parts.slice(0, parts.length - dots).join('.');
          const rest = mod.text.replace(/^\.+/, '');
          base = [anchor, rest].filter(Boolean).join('.');
        } else if (mod) {
          base = mod.text;
        }
        if (base !== undefined) {
          const names = n
            .childrenForFieldName('name')
            .map((c) =>
              c?.type === 'aliased_import' ? c.childForFieldName('name')?.text : c?.text,
            )
            .filter((x): x is string => !!x);
          const submodules = names
            .map((nm) => dotted.get(base ? `${base}.${nm}` : nm))
            .filter((x): x is string => !!x);
          if (submodules.length)
            for (const p of submodules) addImport({ kind: 'module', path: p }, n);
          if (submodules.length < names.length || names.length === 0) {
            const r = base ? resolveAbs(base) : undefined;
            if (r) addImport(r, n);
          }
        }
      } else if (n.type === 'decorated_definition') {
        const def = n.childForFieldName('definition');
        for (const d of n.namedChildren) {
          if (d?.type !== 'decorator') continue;
          const call = d.namedChildren[0];
          if (call?.type !== 'call') {
            if (
              call &&
              /^(\w+\.)?(task|shared_task)$/.test(call.text) &&
              def?.childForFieldName('name')
            )
              addJob(def, n);
            continue;
          }
          const fn = call.childForFieldName('function');
          if (fn?.type === 'attribute') {
            const obj = fn.childForFieldName('object')?.text ?? '';
            const attr = fn.childForFieldName('attribute')?.text ?? '';
            const args = call.childForFieldName('arguments');
            const path = stringValue(args?.namedChildren[0] ?? null);
            const app = appObjects.get(obj);
            if (
              path !== undefined &&
              path.startsWith('/') &&
              (HTTP.has(attr) || attr === 'route' || attr === 'api_route')
            ) {
              const methods = HTTP.has(attr) ? [attr.toUpperCase()] : (methodsKw(args) ?? ['GET']);
              for (const m of methods)
                addEndpoint(
                  m,
                  (app?.prefix ?? '') + path,
                  n,
                  app
                    ? 'resolved'
                    : ['app', 'router', 'api', 'bp'].includes(obj)
                      ? 'heuristic'
                      : undefined,
                  def,
                );
            }
            if (/^(task|shared_task)$/.test(attr)) addJob(def!, n);
          } else if (fn && /^(shared_task|task)$/.test(fn.text) && def) {
            addJob(def, n);
          }
        }
      } else if (n.type === 'call') {
        const fn = n.childForFieldName('function');
        const name = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.text;
        if (name && SQL_CALLEES.has(name)) {
          const sql = stringValue(n.childForFieldName('arguments')?.namedChildren[0] ?? null);
          if (sql && looksLikeSql(sql)) {
            const refs = sqlTableRefs(sql);
            for (const t of refs.writes)
              out.relations.push({
                fromKey: key,
                toKey: `table:${t}`,
                kind: 'writes',
                confidence: 'heuristic',
                resolved: true,
                evidence: [ev(n)],
              });
            for (const t of refs.reads)
              out.relations.push({
                fromKey: key,
                toKey: `table:${t}`,
                kind: 'reads',
                confidence: 'heuristic',
                resolved: true,
                evidence: [ev(n)],
              });
          }
        }
      }
      for (const c of n.namedChildren) if (c) walk(c);
    };
    const pkgDir = nearestPackageDir(f.path, input.manifestDirs) ?? '';
    const addEndpoint = (
      method: string,
      path: string,
      n: TsNode,
      confidence: 'resolved' | 'heuristic' | undefined,
      def: TsNode | null,
    ) => {
      if (!confidence) return;
      const ekey = `endpoint:${pkgDir || '.'}:${method} ${path}`;
      if (!out.entities.some((e) => e.key === ekey)) {
        out.entities.push({
          key: ekey,
          kind: 'endpoint',
          canonicalName: `${method} ${path}`,
          displayName: `${method} ${path}`,
          ownerKey: key,
          attributes: {
            method,
            path,
            package: pkgDir || '.',
            handler: def?.childForFieldName('name')?.text ?? null,
          },
          evidence: [ev(n)],
        });
      }
      out.relations.push({
        fromKey: key,
        toKey: ekey,
        kind: 'exposes',
        confidence,
        resolved: true,
        evidence: [ev(n)],
      });
    };
    const addJob = (def: TsNode, n: TsNode) => {
      const name = def.childForFieldName('name')?.text;
      if (!name) return;
      const jkey = `job:${f.path}#${name}`;
      out.entities.push({
        key: jkey,
        kind: 'job',
        canonicalName: `py:${modName}.${name}`,
        displayName: name,
        ownerKey: key,
        attributes: { framework: 'celery' },
        evidence: [ev(n)],
      });
    };
    walk(root);
    tree.delete();
  }

  for (const [toKey, ev] of externals) {
    const name = toKey.slice('ext:pypi:'.length);
    out.entities.push({
      key: toKey,
      kind: 'package',
      canonicalName: `pypi:${name}`,
      displayName: name,
      ownerKey: 'system',
      attributes: { external: true, ecosystem: 'pypi' },
      evidence: [ev],
    });
  }

  // Console scripts declared in pyproject.toml.
  for (const pp of input.pyprojects) {
    let toml: {
      project?: { scripts?: Record<string, string> };
      tool?: { poetry?: { scripts?: Record<string, string> } };
    };
    try {
      toml = parseToml(pp.text) as typeof toml;
    } catch {
      continue;
    }
    const scripts = { ...(toml.tool?.poetry?.scripts ?? {}), ...(toml.project?.scripts ?? {}) };
    const dir = dirOf(pp.path);
    const lines = pp.text.split('\n');
    for (const [name, target] of Object.entries(scripts)) {
      const line = Math.max(
        1,
        lines.findIndex((l) =>
          new RegExp(`^\\s*["']?${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}["']?\\s*=`).test(l),
        ) + 1,
      );
      const ev: EvidenceRef = {
        path: pp.path,
        contentHash: pp.sha256,
        startLine: line,
        endLine: line,
        excerpt: lines[line - 1]?.trim(),
      };
      const ekey = `entry:${dir || '.'}:${name}`;
      const [mod, fn] = String(target).split(':');
      out.entities.push({
        key: ekey,
        kind: 'entrypoint',
        canonicalName: `console_script ${name}`,
        displayName: name,
        ownerKey: packageKey(dir),
        attributes: { type: 'console_script', target: String(target), function: fn ?? null },
        evidence: [ev],
      });
      const modPath = mod ? dotted.get(mod) : undefined;
      out.relations.push({
        fromKey: ekey,
        toKey: modPath ? pyModuleKey(modPath) : `unresolved:${mod}`,
        kind: 'calls',
        qualifiers: fn ? { function: fn } : undefined,
        confidence: 'resolved',
        resolved: !!modPath,
        evidence: [ev],
      });
    }
  }
  return out;
}

function stringValue(n: TsNode | null): string | undefined {
  if (!n) return undefined;
  if (n.type === 'string') {
    if (n.namedChildren.some((c) => c?.type === 'interpolation')) return undefined;
    return n.namedChildren
      .filter((c) => c?.type === 'string_content')
      .map((c) => c!.text)
      .join('');
  }
  if (n.type === 'concatenated_string') {
    const parts = n.namedChildren.map((c) => stringValue(c));
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  return undefined;
}

function methodsKw(args: TsNode | null): string[] | undefined {
  for (const a of args?.namedChildren ?? []) {
    if (a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'methods') {
      const list = a.childForFieldName('value');
      const vals = list?.namedChildren.map((c) => stringValue(c)).filter((x): x is string => !!x);
      if (vals?.length) return vals.map((v) => v.toUpperCase());
    }
  }
  return undefined;
}
