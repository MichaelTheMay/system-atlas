#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery } from '@atlas/daemon/discovery';
import { ensureDaemon, findDaemon } from './client.ts';
import { runDoctor } from './doctor.ts';

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
    console.log(`project root: ${root}`);
    console.log('note: project registration arrives in ticket A02');
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
