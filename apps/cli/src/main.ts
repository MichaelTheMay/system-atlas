#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery } from '@atlas/daemon/discovery';
import { ensureDaemon, findDaemon } from './client.ts';
import { runDoctor } from './doctor.ts';

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
  .argument('[path]')
  .option('--no-model')
  .description('Analyze a project')
  .action(notYet('scan', 'A03-A05'));
program
  .command('watch')
  .argument('[path]')
  .description('Watch and incrementally update')
  .action(notYet('watch', 'M01'));
program
  .command('views')
  .command('list')
  .option('--json')
  .description('List canvases')
  .action(notYet('views list', 'A06'));
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
