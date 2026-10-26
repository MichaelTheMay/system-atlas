#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery } from '@atlas/daemon/discovery';
import { ensureDaemon, findDaemon } from './client.ts';
import { runDoctor } from './doctor.ts';

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

const paths = resolveAtlasPaths();
const program = new Command();
program
  .name('atlas')
  .description('System Atlas: local architecture and execution-evidence workspace')
  .version('0.1.0');

function notYet(cmd: string, ticket: string) {
  return () => {
    console.error(
      `atlas ${cmd}: not implemented yet (ticket ${ticket}; see IMPLEMENTATION_STATUS.md)`,
    );
    process.exitCode = 2;
  };
}

function uiUrl(baseUrl: string, token: string) {
  // Token travels in the fragment, which browsers never send to servers or in Referer.
  return `${baseUrl}/#token=${token}`;
}

program
  .command('open')
  .description('Start/attach the local daemon and print the UI URL for a project')
  .argument('[path]', 'project root', '.')
  .option('--browser', 'open the URL in the default browser')
  .action(async (path: string, opts: { browser?: boolean }) => {
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
      `  tree: ${snap.snapshot.dirty ? 'dirty (differs from HEAD)' : 'clean at HEAD'}${snap.snapshot.headCommit ? ` ${snap.snapshot.headCommit.slice(0, 12)}` : ''}`,
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
  .command('watch')
  .argument('[path]')
  .description('Watch and incrementally update')
  .action(notYet('watch', 'M01'));
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
  .argument('<command...>')
  .description('Run a command and record evidence')
  .action(notYet('run', 'E02'));
program
  .command('import')
  .argument('<bundle>')
  .description('Import a run bundle')
  .action(notYet('import', 'I03'));
program
  .command('export')
  .option('--snapshot <id>')
  .option('--output <path>')
  .description('Export a bundle')
  .action(notYet('export', 'H01'));

await program.parseAsync();
