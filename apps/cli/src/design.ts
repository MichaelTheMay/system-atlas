import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import type { AtlasPaths } from '@atlas/schema/node';
import { ensureDaemon, type DaemonHandle } from './client.ts';

/**
 * `atlas design generate | status` (D02c). Generation is manual only: this command (or the UI's
 * Generate button) is the only way a design job starts. It prints the estimate and what leaves the
 * machine first; anything but the mock runtime needs `--yes` or an interactive confirmation.
 */
interface Registration {
  project: { id: string; displayName: string };
  worktree: { id: string };
}
interface Estimate {
  snapshotId: string;
  runtime: string;
  model: string | null;
  units: number;
  depth: number;
  maxSubsystemsPerLevel: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  dailyBudget: { maxTokensPerDay: number; tokensCounted: number; remaining: number };
  sends: string;
  external: boolean;
  consented: boolean;
}
interface Job {
  id: string;
  kind: string;
  runtime: string;
  model?: string;
  state: string;
  runId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  proposedClaims?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

const RUNTIMES = ['mock', 'claude-code', 'anthropic-api'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

async function project(daemon: DaemonHandle, path: string) {
  const root = resolve(path);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`not a directory: ${root}`);
  return daemon.api<Registration>('/projects', {
    method: 'POST',
    body: JSON.stringify({ rootPath: root }),
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function registerDesignCommands(program: Command, paths: AtlasPaths) {
  const design = program
    .command('design')
    .description('System-design agent: generate a proposed recursive design, show job status');

  design
    .command('generate')
    .description(
      'Propose a recursive system design (lands as "proposed" for review; manual only, never automatic)',
    )
    .argument('[path]', 'project root', '.')
    .option('--depth <n>', 'subsystem levels below the system view (1-3)', '3')
    .option('--runtime <id>', 'mock | claude-code | anthropic-api (default: the configured one)')
    .option('--model <name>', 'model for claude-code / anthropic-api')
    .option('--replace-proposals', 'reject earlier agent proposals first (accepted work stays)')
    .option('--yes', 'confirm sending data off this machine without asking')
    .option('--json', 'machine-readable output')
    .action(
      async (
        path: string,
        opts: {
          depth: string;
          runtime?: string;
          model?: string;
          replaceProposals?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        if (opts.runtime && !RUNTIMES.includes(opts.runtime)) {
          console.error(`--runtime must be one of ${RUNTIMES.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        const depth = Number(opts.depth);
        if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
          console.error('--depth must be 1, 2 or 3');
          process.exitCode = 1;
          return;
        }
        const { daemon } = await ensureDaemon(paths);
        const reg = await project(daemon, path);
        const qs = new URLSearchParams({ depth: String(depth) });
        if (opts.runtime) qs.set('runtime', opts.runtime);
        let est: Estimate;
        try {
          est = await daemon.api<Estimate>(
            `/projects/${reg.project.id}/design/jobs/estimate?${qs}`,
          );
        } catch {
          console.error('no snapshot yet: run `atlas scan` first');
          process.exitCode = 1;
          return;
        }
        const log = (s: string) => {
          if (!opts.json) console.log(s);
        };
        log(`${reg.project.displayName}: design generate on snapshot ${est.snapshotId}`);
        log(
          `  runtime: ${est.runtime}${opts.model || est.model ? ` (model ${opts.model ?? est.model})` : ''}`,
        );
        log(
          `  ${est.units} box(es), depth ${est.depth}, at most ${est.maxSubsystemsPerLevel} subsystems per level`,
        );
        log(
          `  estimated tokens: ~${est.estimatedInputTokens} in, ~${est.estimatedOutputTokens} out` +
            (est.runtime === 'anthropic-api'
              ? ` (daily budget ${est.dailyBudget.remaining} of ${est.dailyBudget.maxTokensPerDay} left)`
              : ''),
        );
        log(`  leaves this machine: ${est.sends}`);
        if (est.external) {
          const ok = opts.yes || (await confirm('Send this and run the design agent?'));
          if (!ok) {
            console.error('not confirmed: pass --yes to run a non-mock runtime');
            process.exitCode = 1;
            return;
          }
          if (!est.consented)
            await daemon.api('/settings/design-agent', {
              method: 'PUT',
              body: JSON.stringify({ runtime: est.runtime, consent: true }),
            });
        }
        let job = await daemon.api<Job>(`/projects/${reg.project.id}/design/jobs`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'generate',
            runtime: est.runtime,
            snapshotId: est.snapshotId,
            depth,
            ...(opts.model ? { model: opts.model } : {}),
            replaceProposals: !!opts.replaceProposals,
          }),
        });
        log(`  job ${job.id} started (run ${job.runId ?? '?'})`);
        const stop = () => {
          void daemon
            .api(`/projects/${reg.project.id}/design/jobs/${job.id}`, { method: 'DELETE' })
            .catch(() => undefined);
        };
        process.once('SIGINT', stop);
        while (!TERMINAL.has(job.state)) {
          await new Promise((r) => setTimeout(r, 300));
          job = await daemon.api<Job>(`/projects/${reg.project.id}/design/jobs/${job.id}`);
        }
        process.off('SIGINT', stop);
        if (opts.json) console.log(JSON.stringify(job, null, 2));
        else {
          console.log(
            `  ${job.state}: ${job.proposedClaims ?? 0} claim(s) proposed${job.error ? ` (${job.error})` : ''}`,
          );
          if (job.state === 'succeeded')
            console.log(
              '  review them in the System design view (they stay "proposed" until accepted)',
            );
        }
        if (job.state !== 'succeeded') process.exitCode = 1;
      },
    );

  design
    .command('status')
    .description('Recent design-agent jobs of a project')
    .argument('[path]', 'project root', '.')
    .option('--json', 'machine-readable output')
    .action(async (path: string, opts: { json?: boolean }) => {
      const { daemon } = await ensureDaemon(paths);
      const reg = await project(daemon, path);
      const { jobs } = await daemon.api<{ jobs: Job[] }>(
        `/projects/${reg.project.id}/design/jobs?limit=10`,
      );
      if (opts.json) return console.log(JSON.stringify(jobs, null, 2));
      if (!jobs.length) return console.log('no design jobs yet');
      for (const j of jobs)
        console.log(
          `${j.id}  ${j.kind.padEnd(24)} ${j.runtime.padEnd(13)} ${j.state.padEnd(9)} ${j.createdAt}` +
            `${j.runId ? `  run ${j.runId}` : ''}${j.error ? `  (${j.error})` : ''}`,
        );
    });
}
