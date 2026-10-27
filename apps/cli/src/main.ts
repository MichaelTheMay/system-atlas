#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery } from '@atlas/daemon/discovery';
import { ensureDaemon, findDaemon } from './client.ts';
import { runDoctor } from './doctor.ts';
import { registerDesignCommands } from './design.ts';

interface CatalogResponse {
  snapshotId: string;
  canvases: {
    id: string;
    lens: string;
    title: string;
    ownerCanvasId?: string;
    relevanceScore: number;
    relevanceReason: string;
  }[];
  links: { fromCanvasId: string; toCanvasId: string; relation: string }[];
}

interface ScanJob {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}

interface SnapshotSummary {
  snapshot: { id: string; state: string; dirty: boolean; headCommit?: string };
  coverage: {
    totals: { files: number };
    analyzers: { id: string; status: string; filesAnalyzed: number }[];
    gaps: { kind: string; path?: string; detail: string }[];
  };
  counts: { entitiesByKind: Record<string, number>; relationsByKind: Record<string, number> };
  changes: {
    entities: Record<string, number>;
    relations: Record<string, number>;
    issues: number;
    previousSnapshotId?: string;
  } | null;
  openIssues: number;
}

function describeChanges(c: SnapshotSummary['changes']): string {
  if (!c?.previousSnapshotId) return 'first snapshot';
  const part = (r: Record<string, number>) =>
    Object.entries(r)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ') || 'no changes';
  return `entities: ${part(c.entities)}; relations: ${part(c.relations)}`;
}

interface Registration {
  project: { id: string; displayName: string };
  worktree: { id: string; rootPath: string; git?: { branch?: string } };
  created: { project: boolean; worktree: boolean };
}

// `pnpm atlas …` runs from the Atlas checkout; act on the directory the user invoked it from.
if (process.env.INIT_CWD && process.env.npm_lifecycle_event === 'atlas')
  process.chdir(process.env.INIT_CWD);

const paths = resolveAtlasPaths();
const program = new Command();
program
  .name('atlas')
  .description('System Atlas: local architecture and execution-evidence workspace')
  .version('0.1.0');

function uiUrl(baseUrl: string, token: string) {
  // Token travels in the fragment, which browsers never send to servers or in Referer.
  return `${baseUrl}/#token=${token}`;
}

program
  .command('open')
  .description('Start/attach the local daemon and print the UI URL for a project')
  .argument('[path]', 'project root', '.')
  .option('--browser', 'open the URL in the default browser')
  .option('--no-watch', 'do not watch the project for changes')
  .action(async (path: string, opts: { browser?: boolean; watch: boolean }) => {
    const root = resolve(path);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`not a directory: ${root}`);
      process.exitCode = 1;
      return;
    }
    const { daemon, started } = await ensureDaemon(paths);
    console.log(`${started ? 'started' : 'attached to'} atlas daemon pid ${daemon.rec.pid}`);
    const reg = await daemon.api<Registration>('/projects', {
      method: 'POST',
      body: JSON.stringify({ rootPath: root }),
    });
    console.log(
      `${reg.created.worktree ? 'registered' : 'already registered'}: ${reg.project.displayName} (${reg.project.id}), worktree ${reg.worktree.id}` +
        (reg.worktree.git?.branch ? ` on branch ${reg.worktree.git.branch}` : ''),
    );
    if (opts.watch) {
      const w = await daemon.api<{ status: { directories: number } | null }>(
        `/worktrees/${reg.worktree.id}/watch`,
        { method: 'PUT', body: JSON.stringify({ enabled: true }) },
      );
      if (w.status) console.log('watching for changes; stop with: atlas watch --off');
    }
    const url = uiUrl(daemon.baseUrl, daemon.rec.token);
    console.log(`open: ${url}`);
    if (opts.browser) spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  });

program
  .command('status')
  .description('Show daemon status')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const d = await findDaemon(paths);
    const status = d
      ? { running: true, url: d.baseUrl, ...(await d.api<Record<string, unknown>>('/status')) }
      : { running: false };
    if (opts.json) console.log(JSON.stringify(status, null, 2));
    else console.log(d ? `daemon running: pid ${d.rec.pid} at ${d.baseUrl}` : 'daemon not running');
  });

program
  .command('doctor')
  .description('Check the local environment')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const checks = await runDoctor(paths);
    if (opts.json) console.log(JSON.stringify(checks, null, 2));
    else
      for (const c of checks)
        console.log(`${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(24)} ${c.detail}`);
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program
  .command('projects')
  .description('List registered projects and worktrees')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const d = await findDaemon(paths);
    if (!d) {
      console.error('daemon not running; run `atlas open <path>` first');
      process.exitCode = 1;
      return;
    }
    const { projects } = await d.api<{
      projects: { project: Registration['project']; worktrees: Registration['worktree'][] }[];
    }>('/projects');
    if (opts.json) return console.log(JSON.stringify(projects, null, 2));
    if (!projects.length) return console.log('no projects registered');
    for (const p of projects) {
      console.log(`${p.project.displayName}  ${p.project.id}`);
      for (const w of p.worktrees)
        console.log(`  ${w.rootPath}${w.git?.branch ? `  [${w.git.branch}]` : ''}  ${w.id}`);
    }
  });

const daemonCmd = program.command('daemon').description('Manage the local daemon');
daemonCmd.command('start').action(async () => {
  const { daemon, started } = await ensureDaemon(paths);
  console.log(
    `${started ? 'started' : 'already running'}: pid ${daemon.rec.pid} at ${daemon.baseUrl}`,
  );
});
daemonCmd.command('stop').action(async () => {
  const rec = await readDiscovery(paths.discoveryFile);
  if (!rec || !isProcessAlive(rec.pid)) {
    console.log('daemon not running');
    return;
  }
  process.kill(rec.pid, 'SIGTERM');
  console.log(`sent SIGTERM to atlas daemon pid ${rec.pid}`);
});

program
  .command('scan')
  .description(
    'Register (if needed) and analyze a project; prints the snapshot and coverage summary',
  )
  .argument('[path]', 'project root', '.')
  .option('--no-model', 'deterministic analysis only (the default; no model is used yet)')
  .option('--json', 'machine-readable output')
  .action(async (path: string, opts: { json?: boolean }) => {
    const root = resolve(path);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`not a directory: ${root}`);
      process.exitCode = 1;
      return;
    }
    const { daemon } = await ensureDaemon(paths);
    const reg = await daemon.api<Registration>('/projects', {
      method: 'POST',
      body: JSON.stringify({ rootPath: root }),
    });
    let job = await daemon.api<ScanJob>(`/worktrees/${reg.worktree.id}/scans`, { method: 'POST' });
    const started = Date.now();
    while (job.state === 'queued' || job.state === 'running') {
      await new Promise((r) => setTimeout(r, 150));
      job = await daemon.api<ScanJob>(`/jobs/${job.id}`);
    }
    if (job.state !== 'succeeded') {
      console.error(`scan ${job.state}: ${job.error ?? ''}`);
      process.exitCode = 1;
      return;
    }
    const snap = await daemon.api<SnapshotSummary>(`/worktrees/${reg.worktree.id}/snapshot`);
    if (opts.json) return console.log(JSON.stringify({ job, ...snap }, null, 2));
    const c = snap.coverage;
    console.log(
      `${reg.project.displayName}: snapshot ${snap.snapshot.id} ${snap.snapshot.state} in ${Date.now() - started} ms`,
    );
    console.log(
      `  tree: ${!snap.snapshot.headCommit ? 'not a git checkout (no HEAD to compare)' : snap.snapshot.dirty ? `dirty (differs from HEAD ${snap.snapshot.headCommit.slice(0, 12)})` : `clean at HEAD ${snap.snapshot.headCommit.slice(0, 12)}`}`,
    );
    console.log(`  files analyzed: ${c.totals.files}`);
    console.log(
      `  entities: ${
        Object.entries(snap.counts.entitiesByKind)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ') || 'none'
      }`,
    );
    console.log(
      `  relations: ${
        Object.entries(snap.counts.relationsByKind)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ') || 'none'
      }`,
    );
    console.log(
      `  analyzers: ${c.analyzers.map((a) => `${a.id} ${a.status} (${a.filesAnalyzed} files)`).join(', ')}`,
    );
    console.log(`  since previous: ${describeChanges(snap.changes)}`);
    if (snap.openIssues) console.log(`  open reconciliation issues: ${snap.openIssues}`);
    console.log(`  coverage gaps: ${c.gaps.length}`);
    for (const g of c.gaps.slice(0, 15))
      console.log(`    - ${g.kind}${g.path ? ` ${g.path}` : ''}: ${g.detail}`);
    if (c.gaps.length > 15) console.log(`    … ${c.gaps.length - 15} more (use --json)`);
  });
program
  .command('enrich')
  .description(
    'Optional model enrichment (off by default): configure the provider and budget, show usage, or propose claims for entities',
  )
  .argument('[path]', 'project root', '.')
  .option('--provider <name>', 'none | mock | mock-adversarial (no network provider ships)')
  .option('--max-tokens-per-day <n>', 'daily token budget across requests')
  .option('--entity <ids...>', 'entity ids to enrich (from atlas mcp / the UI)')
  .option('--json', 'machine-readable output')
  .action(
    async (
      path: string,
      opts: { provider?: string; maxTokensPerDay?: string; entity?: string[]; json?: boolean },
    ) => {
      const { daemon } = await ensureDaemon(paths);
      const reg = await daemon.api<Registration>('/projects', {
        method: 'POST',
        body: JSON.stringify({ rootPath: resolve(path) }),
      });
      if (opts.provider || opts.maxTokensPerDay) {
        await daemon.api('/settings/enrichment', {
          method: 'PUT',
          body: JSON.stringify({
            ...(opts.provider ? { provider: opts.provider } : {}),
            ...(opts.maxTokensPerDay ? { maxTokensPerDay: Number(opts.maxTokensPerDay) } : {}),
          }),
        });
      }
      if (opts.entity?.length) {
        const r = await daemon.api<{
          results: {
            entityId: string;
            status: string;
            accepted: number;
            rejected: { reasons: string[] }[];
            detail?: string;
          }[];
        }>(`/worktrees/${reg.worktree.id}/enrich`, {
          method: 'POST',
          body: JSON.stringify({ entityIds: opts.entity }),
        });
        if (opts.json) return console.log(JSON.stringify(r, null, 2));
        for (const x of r.results) {
          console.log(
            `${x.entityId}: ${x.status}, ${x.accepted} claim(s) accepted${x.detail ? ` (${x.detail})` : ''}`,
          );
          for (const rej of x.rejected) console.log(`  rejected: ${rej.reasons.join('; ')}`);
        }
        return;
      }
      const s = await daemon.api<{
        settings: Record<string, unknown>;
        usage: Record<string, unknown>;
      }>(`/projects/${reg.project.id}/enrichment`);
      if (opts.json) return console.log(JSON.stringify(s, null, 2));
      console.log(
        `provider: ${String(s.settings.provider)} (budget ${String(s.settings.maxTokensPerDay)} tokens/day)`,
      );
      console.log(
        `today: ${String(s.usage.requests)} request(s), ${String(s.usage.cached)} cached, ${String(s.usage.skippedBudget)} skipped by budget; ` +
          `tokens counted ${String(s.usage.tokensCounted)} (estimated ${String(s.usage.estimated)}, reported ${String(s.usage.reported)})`,
      );
    },
  );

program
  .command('mcp')
  .description(
    'Serve the Atlas MCP tools over stdio for a coding agent, scoped to one project (see docs/agents.md)',
  )
  .argument('[path]', 'project root', '.')
  .action(async (path: string) => {
    // stdout carries the MCP protocol: diagnostics go to stderr only
    const root = resolve(path);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      process.stderr.write(`atlas mcp: not a directory: ${root}\n`);
      process.exitCode = 1;
      return;
    }
    const { daemon } = await ensureDaemon(paths);
    const { createAtlasMcpServer } = await import('@atlas/agent-api');
    const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
    const server = createAtlasMcpServer({
      daemon: { baseUrl: daemon.baseUrl, token: daemon.rec.token },
      rootPath: root,
    });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`atlas mcp: serving ${root} via daemon pid ${daemon.rec.pid}\n`);
  });

program
  .command('watch')
  .description('Watch a project and publish a new snapshot after edits (Ctrl-C stops watching)')
  .argument('[path]', 'project root', '.')
  .option('--detach', 'leave the daemon watching and return immediately')
  .option('--off', 'stop watching this project')
  .action(async (path: string, opts: { detach?: boolean; off?: boolean }) => {
    const root = resolve(path);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`not a directory: ${root}`);
      process.exitCode = 1;
      return;
    }
    const { daemon } = await ensureDaemon(paths);
    const reg = await daemon.api<Registration>('/projects', {
      method: 'POST',
      body: JSON.stringify({ rootPath: root }),
    });
    const wt = reg.worktree.id;
    const setWatch = (enabled: boolean) =>
      daemon.api<{ status: { directories: number; debounceMs: number } | null }>(
        `/worktrees/${wt}/watch`,
        { method: 'PUT', body: JSON.stringify({ enabled }) },
      );
    if (opts.off) {
      await setWatch(false);
      console.log(`stopped watching ${root}`);
      return;
    }
    const { status } = await setWatch(true);
    console.log(`watching ${root} (${status!.debounceMs} ms debounce); Ctrl-C stops watching`);
    if (opts.detach) return;

    const ctrl = new AbortController();
    const stop = () => {
      ctrl.abort();
      void setWatch(false)
        .catch(() => undefined)
        .then(() => {
          console.log('stopped watching');
          process.exit(0);
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const time = () => new Date().toLocaleTimeString();
    const res = await fetch(`${daemon.baseUrl}/api/v1/stream`, {
      headers: { authorization: `Bearer ${daemon.rec.token}` },
      signal: ctrl.signal,
    });
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          const d = JSON.parse(data) as Record<string, unknown>;
          if (d.worktreeId !== wt) continue;
          if (type === 'watch.changed') {
            const sample = (d.sample as string[]).slice(0, 3).join(', ');
            console.log(
              `${time()} ${String(d.changes)} change(s): ${sample}${Number(d.changes) > 3 ? ', …' : ''}`,
            );
          } else if (type === 'snapshot.published') {
            if (d.noop) {
              console.log(`${time()} no effective change`);
              continue;
            }
            const snap = await daemon.api<SnapshotSummary>(`/worktrees/${wt}/snapshot`);
            console.log(
              `${time()} snapshot ${snap.snapshot.id} ${snap.snapshot.state}: ${describeChanges(snap.changes)}`,
            );
          } else if (type === 'scan.failed') {
            console.log(`${time()} scan failed: ${String(d.error)}`);
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
    }
  });
program
  .command('views')
  .description('Generated canvases')
  .command('list')
  .description('List the canvas catalog of the latest snapshot as a navigation tree')
  .argument('[path]', 'project root', '.')
  .option('--json', 'machine-readable output')
  .action(async (path: string, opts: { json?: boolean }) => {
    const { daemon } = await ensureDaemon(paths);
    const reg = await daemon.api<Registration>('/projects', {
      method: 'POST',
      body: JSON.stringify({ rootPath: resolve(path) }),
    });
    let catalog: CatalogResponse;
    try {
      catalog = await daemon.api<CatalogResponse>(`/worktrees/${reg.worktree.id}/canvases`);
    } catch {
      console.error('no snapshot yet; run `atlas scan` first');
      process.exitCode = 1;
      return;
    }
    if (opts.json) return console.log(JSON.stringify(catalog, null, 2));
    const children = new Map<string, string[]>();
    for (const l of catalog.links)
      if (l.relation === 'child')
        (
          children.get(l.fromCanvasId) ?? children.set(l.fromCanvasId, []).get(l.fromCanvasId)!
        ).push(l.toCanvasId);
    const byId = new Map(catalog.canvases.map((c) => [c.id, c]));
    const print = (id: string, depth: number) => {
      const c = byId.get(id)!;
      console.log(
        `${'  '.repeat(depth)}${c.title}  [${c.lens}] relevance ${c.relevanceScore.toFixed(2)}`,
      );
      if (depth === 0) console.log(`${'  '.repeat(depth + 1)}why: ${c.relevanceReason}`);
      for (const k of (children.get(id) ?? []).sort((a, b) =>
        byId.get(a)!.title.localeCompare(byId.get(b)!.title),
      ))
        print(k, depth + 1);
    };
    console.log(`snapshot ${catalog.snapshotId}: ${catalog.canvases.length} canvases`);
    for (const c of catalog.canvases
      .filter((x) => !x.ownerCanvasId)
      .sort((a, b) => b.relevanceScore - a.relevanceScore))
      print(c.id, 0);
  });
program
  .command('run')
  .description(
    'Run a command (no shell) and record its logs, exit, declared outputs and assertions as evidence',
  )
  .argument('<command...>', 'command and arguments, after --')
  .option(
    '-o, --output <path>',
    'declared output file or directory (repeatable)',
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .option('--name <label>', 'label for this run')
  .option(
    '--root <path>',
    'project root (default: the registered project containing the current directory)',
  )
  .option('--json', 'print the run summary as JSON')
  .action(
    async (
      command: string[],
      opts: { output: string[]; name?: string; root?: string; json?: boolean },
    ) => {
      const { runProcess } = await import('@atlas/adapters');
      const { daemon } = await ensureDaemon(paths);
      const cwd = process.cwd();
      let root = opts.root ? resolve(opts.root) : undefined;
      if (!root) {
        const { projects } = await daemon.api<{
          projects: { worktrees: { rootPath: string }[] }[];
        }>('/projects');
        root =
          projects
            .flatMap((p) => p.worktrees.map((w) => w.rootPath))
            .filter((r) => cwd === r || cwd.startsWith(`${r}/`))
            .sort((a, b) => b.length - a.length)[0] ?? cwd;
      }
      const ctrl = new AbortController();
      const onSigint = () => ctrl.abort();
      process.once('SIGINT', onSigint);
      const result = await runProcess({
        daemon: { baseUrl: daemon.baseUrl, token: daemon.rec.token },
        rootPath: root,
        cwd,
        command: command[0]!,
        args: command.slice(1),
        outputs: opts.output,
        name: opts.name,
        echo: !opts.json,
        signal: ctrl.signal,
      });
      process.off('SIGINT', onSigint);
      const detail = await daemon.api<{
        outcome: {
          process: string;
          task: string;
          assertions: { pass: number; fail: number; unknown: number };
        };
        counts: Record<string, number>;
        run: { snapshotId?: string };
      }>(`/runs/${result.runId}`);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...result,
              outcome: detail.outcome,
              counts: detail.counts,
              snapshotId: detail.run.snapshotId ?? null,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(
          `\natlas run ${result.runId}: process ${detail.outcome.process}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}, task ${detail.outcome.task}`,
        );
        const a = detail.outcome.assertions;
        if (a.pass + a.fail + a.unknown)
          console.error(`  assertions: ${a.pass} passed, ${a.fail} failed, ${a.unknown} unknown`);
        for (const out of result.outputs)
          console.error(
            `  output ${out.path}: ${out.state}${out.producedDuringRun === false ? ' (not modified during this run)' : ''}`,
          );
        console.error(
          `  source: ${detail.run.snapshotId ? `snapshot ${detail.run.snapshotId}` : 'tree not yet snapshotted; it will bind when the scan publishes'}`,
        );
        if (result.ingestionErrors.length)
          console.error(
            `  ingestion problems: ${result.ingestionErrors.length} (recorded as capture gaps)`,
          );
      }
      process.exitCode = result.exitCode ?? (result.status === 'cancelled' ? 130 : 1);
    },
  );
program
  .command('import')
  .argument('<source>', 'an OTLP/JSON trace file (.json / .jsonl) or an Atlas run bundle directory')
  .option('--root <path>', 'project the evidence belongs to', '.')
  .option('--json', 'machine-readable output')
  .description(
    'Import approved evidence: OpenTelemetry traces (documented subset) or an Atlas run bundle. Imported runs are not linked to a snapshot.',
  )
  .action(async (source: string, opts: { root: string; json?: boolean }) => {
    const src = resolve(source);
    const st = statSync(src, { throwIfNoEntry: false });
    if (!st) {
      console.error(`not found: ${src}`);
      process.exitCode = 1;
      return;
    }
    const { daemon } = await ensureDaemon(paths);
    const target = { baseUrl: daemon.baseUrl, token: daemon.rec.token };
    const rootPath = resolve(opts.root);
    const { importBundle, importOtlp, BUNDLE_MANIFEST } = await import('@atlas/adapters');
    if (st.isDirectory()) {
      if (!statSync(`${src}/${BUNDLE_MANIFEST}`, { throwIfNoEntry: false })) {
        console.error(`${src} has no ${BUNDLE_MANIFEST}: not an Atlas run bundle`);
        process.exitCode = 1;
        return;
      }
      const r = await importBundle({ daemon: target, rootPath, bundleDir: src });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      if (r.runId)
        console.log(
          `${r.existing ? 'updated' : 'imported'} run ${r.runId}: ${r.events.accepted} new event(s), ${r.events.duplicates} already present, ${r.events.rejected} rejected; ` +
            `${r.artifacts.uploaded} artifact(s), ${r.artifacts.missing} missing, ${r.artifacts.refused} refused`,
        );
      for (const d of r.diagnostics) console.log(`  ${d.severity}: ${d.message}`);
      if (!r.runId) process.exitCode = 1;
      return;
    }
    const { readFile } = await import('node:fs/promises');
    const r = await importOtlp({
      daemon: target,
      rootPath,
      text: await readFile(src, 'utf8'),
      source: src,
    });
    if (opts.json) return console.log(JSON.stringify(r, null, 2));
    for (const x of r.runs)
      console.log(
        `${x.existing ? 'updated' : 'imported'} trace ${x.traceId} as run ${x.runId} (${x.status}): ${x.spans} span(s); ` +
          `${x.events.accepted} new event(s), ${x.events.duplicates} already present, ${x.events.rejected} rejected`,
      );
    for (const d of r.diagnostics) console.log(`  ${d.severity}: ${d.code}: ${d.message}`);
    if (r.runs.length === 0) process.exitCode = 1;
  });
program
  .command('export')
  .description(
    'Export views as linked JSON Canvas files (or Mermaid) and runs as canvases with their artifacts; see docs/export.md',
  )
  .argument('[path]', 'project root', '.')
  .requiredOption('-o, --output <dir>', 'new or empty directory to write to')
  .option('--snapshot <id>', 'snapshot to export views from (default: latest)')
  .option('--view <ids...>', 'canvas ids or titles (default: every view of the snapshot)')
  .option('--run <ids...>', 'run ids to export')
  .option('--format <format>', 'canvas (JSON Canvas 1.0) or mermaid (views only)', 'canvas')
  .option('--include-logs', 'also copy log artifacts (they may contain secrets)')
  .action(
    async (
      path: string,
      opts: {
        output: string;
        snapshot?: string;
        view?: string[];
        run?: string[];
        format: string;
        includeLogs?: boolean;
      },
    ) => {
      if (opts.format !== 'canvas' && opts.format !== 'mermaid') {
        console.error('--format must be canvas or mermaid');
        process.exitCode = 1;
        return;
      }
      const { daemon } = await ensureDaemon(paths);
      const { exportToDir } = await import('./export.ts');
      const r = await exportToDir({
        daemon: { baseUrl: daemon.baseUrl, token: daemon.rec.token },
        rootPath: resolve(path),
        output: resolve(opts.output),
        snapshotId: opts.snapshot,
        views: opts.view,
        runs: opts.run,
        format: opts.format,
        includeLogs: opts.includeLogs,
      });
      console.log(`wrote ${r.files.length} file(s) to ${r.output}`);
      console.log('not carried by the export format:');
      for (const d of [...new Set(r.disclosures)]) console.log(`  - ${d}`);
      for (const p of r.problems) console.log(`  problem: ${p}`);
      if (r.problems.length) process.exitCode = 1;
    },
  );

registerDesignCommands(program, paths);

await program.parseAsync();
