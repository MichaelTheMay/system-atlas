import ts from 'typescript';
import type {
  AnalyzerOutput,
  EntityObservation,
  EvidenceRef,
  RelationObservation,
} from '../types.ts';
import {
  dirOf,
  nearestPackageDir,
  ownerKeyFor,
  packageKey,
  routeShape,
} from '../shared/packages.ts';
import { looksLikeSql, sqlTableRefs } from '../shared/sql.ts';

/**
 * TS/JS extraction over in-memory, hash-verified file texts (runs inside a worker).
 * Uses the TypeScript parser for syntax and a bundler-style resolver restricted to the inventory:
 * Atlas never reads node_modules or anything outside the registered root.
 */
export interface TsInput {
  files: { path: string; text: string; sha256: string; role: string }[];
  packageJsons: { path: string; text: string }[];
  tsconfigs: { path: string; text: string }[];
  manifestDirs: string[];
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const ASSET_EXT =
  /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|json|txt|md|html|wasm|glsl|graphql|gql)$/i;
const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'del',
  'options',
  'head',
  'all',
]);
const SERVER_LIBS = [
  'fastify',
  'express',
  'hono',
  'koa',
  '@koa/router',
  'koa-router',
  'restify',
  '@hapi/hapi',
  'polka',
  'h3',
  'elysia',
];
const SERVER_TYPES = /\b(FastifyInstance|Express|Application|Router|Hono|Koa|IRouter)\b/;
const ROUTE_RECEIVERS = new Set(['app', 'router', 'server', 'api', 'routes', 'fastify', 'r']);
const QUEUE_LIBS = new Set(['bullmq', 'bull', 'bee-queue']);
const ROUTER_LIBS = new Set(['react-router', 'react-router-dom', '@tanstack/react-router']);
const SQL_CALLEES = new Set([
  'query',
  'execute',
  'exec',
  'raw',
  'prepare',
  'run',
  'all',
  'get',
  'sql',
  'unsafe',
  'many',
  'one',
  'none',
  'any',
]);
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'test',
  'sqlite',
]);

interface PkgInfo {
  dir: string;
  name: string;
  entries: Record<string, string>;
  bin: Record<string, string>;
}

interface Consumer {
  from: string;
  method: string;
  shape: string;
  ev: EvidenceRef;
}

/**
 * Everything the TS/JS analyzer needs from one file's syntax, as plain data. It depends only on
 * the file's path and bytes, so it is cached by (analyzer version, path, sha256) and only changed
 * files are re-parsed (plan §9 incremental analysis). `ops` are recorded in AST visit order and
 * replayed by `resolveTs`, which keeps the output identical to a single combined pass.
 */
export interface TsFacts {
  path: string;
  sha256: string;
  role: string;
  lines: number;
  symbols: EntityObservation[];
  consts: [string, string][];
  hasServerTypes: boolean;
  imports: {
    spec: string;
    ev: EvidenceRef;
    typeOnly: boolean;
    names: { local: string; imported: string }[];
  }[];
  ops: TsOp[];
}

export type TsOp =
  | { t: 'import'; spec: string; ev: EvidenceRef }
  | { t: 'route'; method: string; path: string; recv: string; ev: EvidenceRef }
  | { t: 'route-object'; method: string; url: string; ev: EvidenceRef }
  | { t: 'consumer'; method: string; shape: string; ev: EvidenceRef }
  | { t: 'sql'; sql: string; ev: EvidenceRef }
  | { t: 'ui'; path: string; ev: EvidenceRef }
  | {
      t: 'queue';
      kind: 'publishes' | 'subscribes';
      lit?: string;
      ident?: string;
      text: string;
      ev: EvidenceRef;
    };

export interface TsResolveInput {
  facts: TsFacts[];
  packageJsons: TsInput['packageJsons'];
  tsconfigs: TsInput['tsconfigs'];
  manifestDirs: string[];
}

/** Parse one file and record its syntax facts. Pure: depends only on the file's path and bytes. */
export function factsOf(f: TsInput['files'][number]): TsFacts {
  const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, scriptKind(f.path));
  const key = moduleKey(f.path);
  const facts: TsFacts = {
    path: f.path,
    sha256: f.sha256,
    role: f.role,
    lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
    symbols: [],
    consts: [],
    hasServerTypes: SERVER_TYPES.test(sf.text),
    imports: [],
    ops: [],
  };
  for (const st of sf.statements) {
    const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isStringLiteral(d.initializer) || ts.isNoSubstitutionTemplateLiteral(d.initializer))
        ) {
          facts.consts.push([d.name.text, d.initializer.text]);
        }
        if (exported && ts.isIdentifier(d.name))
          facts.symbols.push(symbol(f, sf, d.name.text, d, 'variable', key));
      }
    } else if (
      exported &&
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st))
    ) {
      const name =
        st.name?.text ?? (hasModifier(st, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (name)
        facts.symbols.push(
          symbol(
            f,
            sf,
            name,
            st,
            ts.SyntaxKind[st.kind].replace('Declaration', '').toLowerCase(),
            key,
          ),
        );
    }
  }

  const ev = (node: ts.Node): EvidenceRef => {
    const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return {
      path: f.path,
      contentHash: f.sha256,
      startLine: s,
      endLine: e,
      excerpt: linesOf(sf)
        .slice(s - 1, Math.min(e, s + 2))
        .join('\n')
        .slice(0, 400),
    };
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const names: { local: string; imported: string }[] = [];
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          names.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text });
      facts.imports.push({
        spec: st.moduleSpecifier.text,
        ev: ev(st),
        typeOnly: !!st.importClause?.isTypeOnly,
        names,
      });
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      facts.imports.push({
        spec: st.moduleSpecifier.text,
        ev: ev(st),
        typeOnly: st.isTypeOnly,
        names: [],
      });
    }
  }

  const ops = facts.ops;
  const collectRouteObjects = (arr: ts.ArrayLiteralExpression, prefix: string) => {
    for (const el of arr.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      const p = stringProp(el, 'path');
      const full =
        p === undefined ? prefix : p.startsWith('/') ? p : `${prefix.replace(/\/$/, '')}/${p}`;
      if (p !== undefined) ops.push({ t: 'ui', path: full || '/', ev: ev(el) });
      const children = el.properties.find(
        (x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === 'children',
      );
      if (
        children &&
        ts.isPropertyAssignment(children) &&
        ts.isArrayLiteralExpression(children.initializer)
      )
        collectRouteObjects(children.initializer, full);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      // dynamic import / require
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require')) &&
        arg0 &&
        ts.isStringLiteralLike(arg0)
      ) {
        ops.push({ t: 'import', spec: arg0.text, ev: ev(node) });
      }
      // HTTP route declarations: <receiver>.<method>('/path', ...)
      if (
        ts.isPropertyAccessExpression(callee) &&
        HTTP_METHODS.has(callee.name.text) &&
        arg0 &&
        ts.isStringLiteralLike(arg0) &&
        arg0.text.startsWith('/')
      ) {
        const receiver = callee.expression;
        const recv = ts.isIdentifier(receiver)
          ? receiver.text
          : ts.isPropertyAccessExpression(receiver)
            ? receiver.name.text
            : '';
        const method =
          callee.name.text === 'all'
            ? 'ANY'
            : callee.name.text === 'del'
              ? 'DELETE'
              : callee.name.text.toUpperCase();
        ops.push({ t: 'route', method, path: arg0.text, recv, ev: ev(node) });
      }
      // fastify app.route({ method, url })
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'route' &&
        arg0 &&
        ts.isObjectLiteralExpression(arg0)
      ) {
        const method = stringProp(arg0, 'method');
        const url = stringProp(arg0, 'url') ?? stringProp(arg0, 'path');
        if (method && url)
          ops.push({ t: 'route-object', method: method.toUpperCase(), url, ev: ev(node) });
      }
      // HTTP consumers: fetch('/x', { method }) and axios.<method>('/x')
      const isFetch = ts.isIdentifier(callee) && callee.text === 'fetch';
      const isAxios =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ['axios', 'http', 'client', 'api'].includes(callee.expression.text) &&
        HTTP_METHODS.has(callee.name.text);
      if ((isFetch || isAxios) && arg0) {
        const url = urlTemplate(arg0);
        if (url && url.startsWith('/')) {
          let method = 'GET';
          if (isAxios) method = (callee as ts.PropertyAccessExpression).name.text.toUpperCase();
          else if (node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1]))
            method = (stringProp(node.arguments[1], 'method') ?? 'GET').toUpperCase();
          ops.push({ t: 'consumer', method, shape: routeShape(url), ev: ev(node) });
        }
      }
      // SQL text passed to query-like calls
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      if (SQL_CALLEES.has(calleeName) && arg0) {
        const sql = ts.isStringLiteralLike(arg0)
          ? arg0.text
          : ts.isTemplateExpression(arg0)
            ? arg0.head.text + arg0.templateSpans.map((s) => ` ? ${s.literal.text}`).join('')
            : undefined;
        if (sql && looksLikeSql(sql)) ops.push({ t: 'sql', sql, ev: ev(node) });
      }
      // react-router data routers / useRoutes
      if (
        ts.isIdentifier(callee) &&
        /^(create(Browser|Hash|Memory|Static)Router|useRoutes)$/.test(callee.text) &&
        arg0 &&
        ts.isArrayLiteralExpression(arg0)
      ) {
        collectRouteObjects(arg0, '');
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql'
    ) {
      const t = node.template;
      const sql = ts.isNoSubstitutionTemplateLiteral(t)
        ? t.text
        : t.head.text + t.templateSpans.map((s) => ` ? ${s.literal.text}`).join('');
      if (looksLikeSql(sql)) ops.push({ t: 'sql', sql, ev: ev(node) });
    }
    // BullMQ-style queues (kept only when the file imports a queue library; decided at resolve time)
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments?.[0]) {
      const cls = node.expression.text;
      const kind =
        cls === 'Queue' || cls === 'FlowProducer'
          ? 'publishes'
          : cls === 'Worker' || cls === 'QueueEvents'
            ? 'subscribes'
            : undefined;
      if (kind) {
        const nameExpr = node.arguments[0];
        ops.push({
          t: 'queue',
          kind,
          lit: ts.isStringLiteralLike(nameExpr) ? nameExpr.text : undefined,
          ident: ts.isIdentifier(nameExpr) ? nameExpr.text : undefined,
          text: nameExpr.getText(sf).slice(0, 60),
          ev: ev(node),
        });
      }
    }
    // <Route path="/x" />
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === 'Route'
    ) {
      for (const a of node.attributes.properties) {
        if (
          ts.isJsxAttribute(a) &&
          ts.isIdentifier(a.name) &&
          a.name.text === 'path' &&
          a.initializer &&
          ts.isStringLiteral(a.initializer)
        ) {
          ops.push({ t: 'ui', path: a.initializer.text, ev: ev(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

export function extractTs(input: TsInput): AnalyzerOutput {
  return resolveTs({
    facts: input.files.map(factsOf),
    packageJsons: input.packageJsons,
    tsconfigs: input.tsconfigs,
    manifestDirs: input.manifestDirs,
  });
}

/** Whole-repository step over cached per-file facts: module resolution, endpoints, queues, consumers. */
export function resolveTs(input: TsResolveInput): AnalyzerOutput {
  const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
  const fileSet = new Map(input.facts.map((f) => [f.path, f]));
  const pkgs = parsePackages(input.packageJsons, out);
  const aliases = parseTsconfigs(input.tsconfigs, out);
  const externals = new Map<string, EvidenceRef>();
  const endpoints = new Map<string, { pkgDir: string; method: string; shape: string }>();
  const uiKeys = new Set<string>();
  const queueKeys = new Set<string>();
  const consumers: Consumer[] = [];
  const queueUses: {
    from: string;
    path: string;
    op: Extract<TsOp, { t: 'queue' }>;
  }[] = [];
  /** string constants per module path, for queue/topic name resolution */
  const constants = new Map<string, Map<string, string>>();
  /** import bindings per module: local name -> { module path, imported name } */
  const bindings = new Map<string, Map<string, { target: string; name: string }>>();
  const copy = (ev: EvidenceRef): EvidenceRef => ({ ...ev });

  const resolve = (
    from: string,
    spec: string,
  ):
    | { kind: 'file'; path: string }
    | { kind: 'pkg'; dir: string }
    | { kind: 'external'; name: string }
    | { kind: 'builtin' }
    | { kind: 'unresolved' } => {
    if (
      spec.startsWith('node:') ||
      NODE_BUILTINS.has(spec) ||
      NODE_BUILTINS.has(spec.split('/')[0]!)
    )
      return { kind: 'builtin' };
    // style/asset/data imports are bundler concerns, not module dependencies
    if (ASSET_EXT.test(spec.split('?')[0]!)) return { kind: 'builtin' };
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec.slice(1) : join(dirOf(from), spec);
      const hit = probe(base, fileSet);
      return hit ? { kind: 'file', path: hit } : { kind: 'unresolved' };
    }
    for (const a of aliases) {
      if (!(from === a.dir || from.startsWith(a.dir ? `${a.dir}/` : ''))) continue;
      for (const [pattern, targets] of a.paths) {
        const star = pattern.indexOf('*');
        const match =
          star < 0
            ? spec === pattern
            : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
        if (!match) continue;
        const captured =
          star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
        for (const t of targets) {
          const hit = probe(join(a.baseDir, t.replace('*', captured)), fileSet);
          if (hit) return { kind: 'file', path: hit };
        }
      }
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    const sub = spec.slice(name.length);
    const pkg = pkgs.get(name);
    if (pkg) {
      const entry = pkg.entries[`.${sub}`] ?? (sub ? undefined : pkg.entries['.']);
      const candidates = [
        entry && join(pkg.dir, entry),
        sub && join(pkg.dir, sub.slice(1)),
        sub && join(pkg.dir, `src/${sub.slice(1)}`),
        !sub && join(pkg.dir, 'src/index'),
        !sub && join(pkg.dir, 'index'),
      ];
      for (const c of candidates) {
        if (!c) continue;
        const hit = probe(c, fileSet);
        if (hit) return { kind: 'file', path: hit };
      }
      return { kind: 'pkg', dir: pkg.dir };
    }
    return { kind: 'external', name };
  };

  // Pass 1: modules and exported symbols, constants.
  for (const f of input.facts) {
    const key = moduleKey(f.path);
    out.entities.push({
      key,
      kind: 'module',
      canonicalName: `ts:${f.path}`,
      displayName: f.path.slice(f.path.lastIndexOf('/') + 1),
      ownerKey: ownerKeyFor(f.path, input.manifestDirs),
      attributes: { path: f.path, lines: f.lines, test: f.role === 'test' },
      evidence: [{ path: f.path, contentHash: f.sha256, startLine: 1, endLine: f.lines }],
    });
    out.handled.push({ path: f.path, support: 'deep' });
    constants.set(f.path, new Map(f.consts));
    bindings.set(f.path, new Map());
    for (const sym of f.symbols) out.entities.push({ ...sym, evidence: sym.evidence.map(copy) });
  }

  // Pass 2: imports, routes, consumers, queues, SQL, UI routes.
  for (const f of input.facts) {
    const from = moduleKey(f.path);
    const pkgDir = nearestPackageDir(f.path, input.manifestDirs) ?? '';
    const importedLibs = new Set<string>();
    const seenImport = new Set<string>();
    const addImport = (
      spec: string,
      ev: EvidenceRef,
      typeOnly: boolean,
      names: { local: string; imported: string }[],
    ) => {
      const r = resolve(f.path, spec);
      if (r.kind === 'builtin') return;
      if (r.kind === 'external') {
        importedLibs.add(r.name);
        const toKey = `ext:npm:${r.name}`;
        if (!externals.has(toKey)) externals.set(toKey, copy(ev));
        if (!seenImport.has(toKey))
          out.relations.push({
            fromKey: from,
            toKey,
            kind: 'imports',
            qualifiers: typeOnly ? { typeOnly: 'true' } : undefined,
            confidence: 'exact',
            resolved: true,
            evidence: [copy(ev)],
          });
        seenImport.add(toKey);
        return;
      }
      if (r.kind === 'unresolved') {
        out.relations.push({
          fromKey: from,
          toKey: `unresolved:${spec}`,
          kind: 'imports',
          confidence: 'heuristic',
          resolved: false,
          evidence: [copy(ev)],
        });
        return;
      }
      const toKey = r.kind === 'file' ? moduleKey(r.path) : packageKey(r.dir);
      if (r.kind === 'file')
        for (const n of names)
          bindings.get(f.path)!.set(n.local, { target: r.path, name: n.imported });
      if (toKey === from || seenImport.has(toKey)) return;
      seenImport.add(toKey);
      out.relations.push({
        fromKey: from,
        toKey,
        kind: 'imports',
        qualifiers: typeOnly ? { typeOnly: 'true' } : undefined,
        confidence: 'resolved',
        resolved: true,
        evidence: [copy(ev)],
      });
    };
    for (const im of f.imports) addImport(im.spec, im.ev, im.typeOnly, im.names);
    const serverFile = SERVER_LIBS.some((l) => importedLibs.has(l)) || f.hasServerTypes;
    const queueLib = [...importedLibs].some((l) => QUEUE_LIBS.has(l));
    const routerLib = [...importedLibs].some((l) => ROUTER_LIBS.has(l));

    const addEndpoint = (
      method: string,
      path: string,
      ev: EvidenceRef,
      confidence: 'resolved' | 'heuristic',
    ) => {
      const key = `endpoint:${pkgDir || '.'}:${method} ${path}`;
      if (!endpoints.has(key)) {
        endpoints.set(key, { pkgDir, method, shape: routeShape(path) });
        out.entities.push({
          key,
          kind: 'endpoint',
          canonicalName: `${method} ${path}`,
          displayName: `${method} ${path}`,
          ownerKey: from,
          attributes: { method, path, package: pkgDir || '.' },
          evidence: [copy(ev)],
        });
      }
      out.relations.push({
        fromKey: from,
        toKey: key,
        kind: 'exposes',
        confidence,
        resolved: true,
        evidence: [copy(ev)],
      });
    };
    const addUi = (path: string, ev: EvidenceRef, confidence: 'resolved' | 'heuristic') => {
      const key = `ui:${pkgDir || '.'}:${path}`;
      if (!uiKeys.has(key)) {
        uiKeys.add(key);
        out.entities.push({
          key,
          kind: 'ui-surface',
          canonicalName: `route ${path}`,
          displayName: path,
          ownerKey: from,
          attributes: { path, package: pkgDir || '.' },
          evidence: [copy(ev)],
        });
      }
      out.relations.push({
        fromKey: from,
        toKey: key,
        kind: 'exposes',
        confidence,
        resolved: true,
        evidence: [copy(ev)],
      });
    };
    const addSql = (sql: string, ev: EvidenceRef) => {
      const refs = sqlTableRefs(sql);
      for (const t of refs.writes)
        out.relations.push({
          fromKey: from,
          toKey: `table:${t}`,
          kind: 'writes',
          confidence: 'heuristic',
          resolved: true,
          evidence: [copy(ev)],
        });
      for (const t of refs.reads)
        out.relations.push({
          fromKey: from,
          toKey: `table:${t}`,
          kind: 'reads',
          confidence: 'heuristic',
          resolved: true,
          evidence: [copy(ev)],
        });
    };

    for (const op of f.ops) {
      switch (op.t) {
        case 'import':
          addImport(op.spec, op.ev, false, []);
          break;
        case 'route':
          if (serverFile || ROUTE_RECEIVERS.has(op.recv))
            addEndpoint(op.method, op.path, op.ev, serverFile ? 'resolved' : 'heuristic');
          break;
        case 'route-object':
          if (serverFile) addEndpoint(op.method, op.url, op.ev, 'resolved');
          break;
        case 'consumer':
          consumers.push({ from, method: op.method, shape: op.shape, ev: copy(op.ev) });
          break;
        case 'sql':
          addSql(op.sql, op.ev);
          break;
        case 'ui':
          addUi(op.path, op.ev, routerLib ? 'resolved' : 'heuristic');
          break;
        case 'queue':
          if (queueLib) queueUses.push({ from, path: f.path, op });
          break;
      }
    }
  }

  // Queue names: string literal, local constant, or imported constant.
  for (const q of queueUses) {
    const name =
      q.op.lit ?? (q.op.ident ? constValue(q.op.ident, q.path, constants, bindings) : undefined);
    if (name) {
      const key = `queue:${name}`;
      if (!queueKeys.has(key)) {
        queueKeys.add(key);
        out.entities.push({
          key,
          kind: 'queue',
          canonicalName: `queue:${name}`,
          displayName: name,
          attributes: { name },
          evidence: [copy(q.op.ev)],
        });
      }
      out.relations.push({
        fromKey: q.from,
        toKey: key,
        kind: q.op.kind,
        confidence: 'resolved',
        resolved: true,
        evidence: [copy(q.op.ev)],
      });
    } else {
      out.relations.push({
        fromKey: q.from,
        toKey: `unresolved:queue name ${q.op.text}`,
        kind: q.op.kind,
        confidence: 'heuristic',
        resolved: false,
        evidence: [copy(q.op.ev)],
      });
    }
  }

  // HTTP consumers -> endpoints with the same method and path shape (heuristic: no base URL resolution).
  for (const c of consumers) {
    const matches = [...endpoints.entries()].filter(
      ([, e]) => (e.method === c.method || e.method === 'ANY') && e.shape === c.shape,
    );
    if (matches.length === 1) {
      out.relations.push({
        fromKey: c.from,
        toKey: matches[0]![0],
        kind: 'calls',
        confidence: 'heuristic',
        resolved: true,
        evidence: [c.ev],
      });
    } else if (matches.length > 1) {
      out.diagnostics.push({
        severity: 'info',
        code: 'ambiguous-http-consumer',
        message: `${c.method} ${c.shape} matches ${matches.length} endpoints; not linked`,
        path: c.ev.path,
        line: c.ev.startLine,
      });
    }
  }

  for (const [key, ev] of externals) {
    const name = key.slice('ext:npm:'.length);
    out.entities.push({
      key,
      kind: 'package',
      canonicalName: `npm:${name}`,
      displayName: name,
      ownerKey: 'system',
      attributes: { external: true, ecosystem: 'npm' },
      evidence: [ev],
    });
  }

  // Package bin entries are declared entrypoints.
  for (const p of pkgs.values()) {
    for (const [name, target] of Object.entries(p.bin)) {
      const hit = probe(join(p.dir, target), fileSet);
      const key = `entry:${p.dir || '.'}:${name}`;
      const manifest = input.packageJsons.find((j) => dirOf(j.path) === p.dir)!;
      const ev: EvidenceRef = {
        path: manifest.path,
        contentHash: '',
        startLine: lineOf(manifest.text, `"${name}"`),
      };
      out.entities.push({
        key,
        kind: 'entrypoint',
        canonicalName: `bin ${name}`,
        displayName: name,
        ownerKey: packageKey(p.dir),
        attributes: { type: 'bin', target },
        evidence: [ev],
      });
      out.relations.push({
        fromKey: key,
        toKey: hit ? moduleKey(hit) : `unresolved:${target}`,
        kind: 'calls',
        confidence: 'resolved',
        resolved: !!hit,
        evidence: [ev],
      });
    }
  }
  return out;
}

export const moduleKey = (path: string) => `ts:module:${path}`;

/** `text.split('\n')`, computed once per file (evidence excerpts are cut from it many times). */
const lineCache = new WeakMap<ts.SourceFile, string[]>();
function linesOf(sf: ts.SourceFile): string[] {
  let l = lineCache.get(sf);
  if (!l) lineCache.set(sf, (l = sf.text.split('\n')));
  return l;
}

function symbol(
  f: { path: string; sha256: string },
  sf: ts.SourceFile,
  name: string,
  node: ts.Node,
  symbolKind: string,
  moduleKeyStr: string,
): EntityObservation {
  const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return {
    key: `ts:symbol:${f.path}#${name}`,
    kind: 'symbol',
    canonicalName: `ts:${f.path}#${name}`,
    displayName: name,
    ownerKey: moduleKeyStr,
    attributes: { symbolKind, exported: true },
    evidence: [
      {
        path: f.path,
        contentHash: f.sha256,
        startLine: s,
        endLine: e,
        excerpt: linesOf(sf)[s - 1]?.slice(0, 300),
      },
    ],
  };
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ??
    false
  );
}

function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name &&
      ts.isStringLiteralLike(p.initializer)
    )
      return p.initializer.text;
  }
  return undefined;
}

function urlTemplate(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => `\${}${s.literal.text}`).join('');
  return undefined;
}

function constValue(
  ident: string,
  path: string,
  constants: Map<string, Map<string, string>>,
  bindings: Map<string, Map<string, { target: string; name: string }>>,
): string | undefined {
  const local = constants.get(path)?.get(ident);
  if (local) return local;
  const b = bindings.get(path)?.get(ident);
  return b ? constants.get(b.target)?.get(b.name) : undefined;
}

function join(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function probe(base: string, files: Map<string, unknown>): string | undefined {
  const b = base.replace(/\/$/, '');
  if (files.has(b)) return b;
  const noJs = b.replace(/\.(m|c)?jsx?$/, '');
  for (const stem of noJs === b ? [b] : [noJs, b]) {
    for (const ext of EXTS) if (files.has(stem + ext)) return stem + ext;
  }
  for (const ext of EXTS) if (files.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
  return undefined;
}

function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

function parsePackages(pjs: TsInput['packageJsons'], out: AnalyzerOutput): Map<string, PkgInfo> {
  const map = new Map<string, PkgInfo>();
  for (const pj of pjs) {
    try {
      const j = JSON.parse(pj.text) as Record<string, unknown>;
      if (typeof j.name !== 'string') continue;
      const entries: Record<string, string> = {};
      const exp = j.exports;
      const pick = (v: unknown): string | undefined =>
        typeof v === 'string'
          ? v
          : v && typeof v === 'object'
            ? pick(
                (v as Record<string, unknown>).source ??
                  (v as Record<string, unknown>).import ??
                  (v as Record<string, unknown>).default ??
                  (v as Record<string, unknown>).types,
              )
            : undefined;
      if (typeof exp === 'string') entries['.'] = exp;
      else if (exp && typeof exp === 'object') {
        for (const [k, v] of Object.entries(exp as Record<string, unknown>)) {
          const t = pick(v);
          if (k.startsWith('.') && t) entries[k] = t;
          else if (!k.startsWith('.') && t && !entries['.']) entries['.'] = t;
        }
      }
      for (const field of ['source', 'module', 'main', 'types'])
        if (!entries['.'] && typeof j[field] === 'string') entries['.'] = j[field] as string;
      const bin: Record<string, string> =
        typeof j.bin === 'string'
          ? { [j.name.split('/').pop()!]: j.bin }
          : ((j.bin as Record<string, string>) ?? {});
      map.set(j.name, { dir: dirOf(pj.path), name: j.name, entries, bin });
    } catch (e) {
      out.diagnostics.push({
        severity: 'warning',
        code: 'package-json-invalid',
        message: (e as Error).message.slice(0, 200),
        path: pj.path,
      });
    }
  }
  return map;
}

function parseTsconfigs(
  cfgs: TsInput['tsconfigs'],
  out: AnalyzerOutput,
): { dir: string; baseDir: string; paths: [string, string[]][] }[] {
  const res: { dir: string; baseDir: string; paths: [string, string[]][] }[] = [];
  for (const c of cfgs) {
    const parsed = ts.parseConfigFileTextToJson(c.path, c.text);
    if (parsed.error) {
      out.diagnostics.push({
        severity: 'info',
        code: 'tsconfig-unreadable',
        message: ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ').slice(0, 200),
        path: c.path,
      });
      continue;
    }
    const co = (parsed.config?.compilerOptions ?? {}) as {
      baseUrl?: string;
      paths?: Record<string, string[]>;
    };
    if (!co.paths) continue;
    const dir = dirOf(c.path);
    res.push({ dir, baseDir: join(dir, co.baseUrl ?? '.'), paths: Object.entries(co.paths) });
  }
  return res.sort((a, b) => b.dir.length - a.dir.length);
}

export type { RelationObservation };
