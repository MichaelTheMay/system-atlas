import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  componentTypeInfo,
  DOC_SECTION_LABEL,
  DocSection,
  type DesignBoard,
  type DesignBoardSummary,
} from '@atlas/schema';
import type { AtlasPaths } from '@atlas/schema/node';
import { ensureDaemon, type DaemonHandle } from './client.ts';

/**
 * `atlas board list | show | export | draft | critique | plan` (D03c). Design boards are
 * design-first whiteboards; agent jobs here are manual only and their output lands as
 * "proposed" for review in the UI (or `POST /boards/:id/review`). Any runtime but the mock
 * needs `--yes` (or an interactive confirmation) and records consent, like `atlas design`.
 */
interface Job {
  id: string;
  kind: string;
  runtime: string;
  model?: string;
  state: string;
  runId?: string;
  error?: string;
  boardId?: string;
  proposedBoardItems?: number;
  result?: string;
}
interface Settings {
  runtime: string;
  consented: Record<string, boolean>;
  sends: Record<string, string>;
}

const RUNTIMES = ['mock', 'claude-code', 'anthropic-api'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const BOARD_RE = /^brd_[0-9a-f]{16,64}$/;

async function projectOf(daemon: DaemonHandle, path: string) {
  const root = resolve(path);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`not a directory: ${root}`);
  return daemon.api<{ project: { id: string; displayName: string } }>('/projects', {
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

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

async function getBoard(daemon: DaemonHandle, id: string): Promise<DesignBoard | undefined> {
  if (!BOARD_RE.test(id)) return undefined;
  return daemon.api<DesignBoard>(`/boards/${id}`).catch(() => undefined);
}

/** A board as a Markdown design doc (components, connections, scenarios, doc, plan). */
export function boardMarkdown(b: DesignBoard): string {
  const d = b.document;
  const tag = (x: { status: string; origin: { author: string; name?: string } }) =>
    x.status === 'proposed' ? ` _(proposed by ${x.origin.name ?? x.origin.author})_` : '';
  const live = <T extends { status: string }>(xs: T[]) => xs.filter((x) => x.status !== 'rejected');
  const comps = live(Object.values(d.components));
  const name = (id: string) => d.components[id]?.label ?? id;
  const out = [`# ${b.name}`, ''];
  if (d.doc.summary) out.push(d.doc.summary, '');
  out.push('## Components', '');
  for (const c of comps) {
    const props = Object.entries(c.props).map(([k, v]) => `${k}: ${String(v)}`);
    out.push(
      `- **${c.label}** (${componentTypeInfo(c.type).label})${props.length ? ` — ${props.join(', ')}` : ''}${c.responsibility ? `: ${c.responsibility}` : ''}${tag(c)}`,
    );
  }
  const cons = live(Object.values(d.connections));
  if (cons.length) {
    out.push('', '## Connections', '');
    for (const k of cons)
      out.push(
        `- ${name(k.from)} → ${name(k.to)}: ${[k.protocol, k.mode, k.payload, k.volume].filter(Boolean).join(', ')}${tag(k)}`,
      );
  }
  for (const s of live(d.scenarios)) {
    out.push('', `## Scenario: ${s.name}${tag(s)}`, '');
    if (s.description) out.push(s.description, '');
    s.steps.forEach((st, i) => out.push(`${i + 1}. ${st.text}`));
  }
  for (const section of DocSection.options) {
    const items = live(d.doc.items).filter((i) => i.section === section);
    if (!items.length) continue;
    out.push('', `## ${DOC_SECTION_LABEL[section]}`, '');
    for (const i of items)
      out.push(`- ${i.text}${i.pins.length ? ` (${i.pins.map(name).join(', ')})` : ''}${tag(i)}`);
  }
  if (d.doc.plan) out.push('', '---', '', d.doc.plan);
  return `${out.join('\n')}\n`;
}

/** Start a board job, wait for it, print the outcome. Returns the finished job. */
async function runJob(
  daemon: DaemonHandle,
  projectId: string,
  body: Record<string, unknown>,
  opts: { runtime?: string; yes?: boolean; json?: boolean },
): Promise<Job | undefined> {
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) {
    fail(`--runtime must be one of ${RUNTIMES.join(', ')}`);
    return undefined;
  }
  const s = await daemon.api<Settings>('/settings/design-agent');
  const runtime = opts.runtime ?? s.runtime;
  const log = (m: string) => {
    if (!opts.json) console.log(m);
  };
  log(`  runtime: ${runtime}`);
  log(`  leaves this machine: ${s.sends[runtime] ?? ''}`);
  if (runtime !== 'mock') {
    if (!(opts.yes || (await confirm('Send this and run the design agent?')))) {
      fail('not confirmed: pass --yes to run a non-mock runtime');
      return undefined;
    }
    if (!s.consented[runtime])
      await daemon.api('/settings/design-agent', {
        method: 'PUT',
        body: JSON.stringify({ runtime, consent: true }),
      });
  }
  let job = await daemon.api<Job>(`/projects/${projectId}/design/jobs`, {
    method: 'POST',
    body: JSON.stringify({ ...body, runtime }),
  });
  log(`  job ${job.id} started (run ${job.runId ?? '?'})`);
  const stop = () => {
    void daemon
      .api(`/projects/${projectId}/design/jobs/${job.id}`, { method: 'DELETE' })
      .catch(() => undefined);
  };
  process.once('SIGINT', stop);
  while (!TERMINAL.has(job.state)) {
    await new Promise((r) => setTimeout(r, 250));
    job = await daemon.api<Job>(`/projects/${projectId}/design/jobs/${job.id}`);
  }
  process.off('SIGINT', stop);
  if (job.state !== 'succeeded') process.exitCode = 1;
  return job;
}

export function registerBoardCommands(program: Command, paths: AtlasPaths) {
  const board = program
    .command('board')
    .description(
      'Design boards: list, show, export; agent draft, critique and implementation plan',
    );

  board
    .command('list')
    .description('Design boards of a project')
    .argument('[path]', 'project root', '.')
    .option('--json', 'machine-readable output')
    .action(async (path: string, opts: { json?: boolean }) => {
      const { daemon } = await ensureDaemon(paths);
      const reg = await projectOf(daemon, path);
      const { boards } = await daemon.api<{ boards: DesignBoardSummary[] }>(
        `/projects/${reg.project.id}/boards`,
      );
      if (opts.json) return console.log(JSON.stringify(boards, null, 2));
      if (!boards.length) return console.log('no boards yet');
      for (const b of boards)
        console.log(
          `${b.id}  ${b.name.padEnd(40)} ${String(b.componentCount).padStart(3)} component(s)  ${b.source.padEnd(8)} ${b.updatedAt}`,
        );
    });

  board
    .command('show')
    .description('A board as its layout-free spec (components, connections, scenarios, doc)')
    .argument('<id>', 'board id (brd_…)')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { json?: boolean }) => {
      const { daemon } = await ensureDaemon(paths);
      if (!BOARD_RE.test(id)) return fail(`not a board id: ${id}`);
      const v = await daemon
        .api<{ name: string; source: string; spec: Record<string, unknown[]> }>(
          `/boards/${id}/spec`,
        )
        .catch(() => undefined);
      if (!v) return fail(`unknown board: ${id}`);
      if (opts.json) return console.log(JSON.stringify(v, null, 2));
      const b = (await getBoard(daemon, id))!;
      process.stdout.write(boardMarkdown(b));
    });

  board
    .command('export')
    .description('Export a board: JSON document (default) or a Markdown design doc')
    .argument('<id>', 'board id (brd_…)')
    .option('--markdown', 'Markdown design doc instead of JSON')
    .action(async (id: string, opts: { markdown?: boolean }) => {
      const { daemon } = await ensureDaemon(paths);
      const b = await getBoard(daemon, id);
      if (!b) return fail(`unknown board: ${id}`);
      if (opts.markdown) process.stdout.write(boardMarkdown(b));
      else console.log(JSON.stringify(b, null, 2));
    });

  board
    .command('draft')
    .description('Draft a new board from a prompt (lands as "proposed"; manual only)')
    .argument('<prompt>', 'what to design, e.g. "a URL shortener"')
    .option('--path <path>', 'project root', '.')
    .option('--runtime <id>', 'mock | claude-code | anthropic-api (default: the configured one)')
    .option('--yes', 'confirm sending data off this machine without asking')
    .option('--json', 'machine-readable output')
    .action(
      async (
        prompt: string,
        opts: { path: string; runtime?: string; yes?: boolean; json?: boolean },
      ) => {
        const { daemon } = await ensureDaemon(paths);
        const reg = await projectOf(daemon, opts.path);
        if (!opts.json) console.log(`${reg.project.displayName}: draft board`);
        const job = await runJob(
          daemon,
          reg.project.id,
          { kind: 'draft-board', prompt: prompt.slice(0, 4000) },
          opts,
        );
        if (!job) return;
        if (opts.json) return console.log(JSON.stringify(job, null, 2));
        console.log(
          `  ${job.state}: ${job.proposedBoardItems ?? 0} item(s) proposed${job.boardId ? ` on board ${job.boardId}` : ''}${job.error ? ` (${job.error})` : ''}`,
        );
        if (job.state === 'succeeded')
          console.log('  review them on the board (they stay "proposed" until accepted)');
      },
    );

  const onBoard =
    (kind: 'critique-board' | 'implementation-plan', what: string) =>
    async (id: string, opts: { runtime?: string; yes?: boolean; json?: boolean }) => {
      const { daemon } = await ensureDaemon(paths);
      const b = await getBoard(daemon, id);
      if (!b) return fail(`unknown board: ${id}`);
      if (!opts.json) console.log(`${b.name}: ${what}`);
      const job = await runJob(daemon, b.projectId, { kind, boardId: b.id }, opts);
      if (!job) return;
      if (opts.json) return console.log(JSON.stringify(job, null, 2));
      if (job.state !== 'succeeded')
        return console.log(`  ${job.state}${job.error ? `: ${job.error}` : ''}`);
      if (kind === 'implementation-plan') process.stdout.write(`\n${job.result ?? ''}\n`);
      else {
        const after = (await getBoard(daemon, b.id))!;
        const mine = after.document.doc.items.filter(
          (i) => i.origin.jobId === job.id && i.status === 'proposed',
        );
        console.log(`  ${mine.length} finding(s) proposed:`);
        for (const i of mine) console.log(`  - [${i.section}] ${i.text}`);
      }
    };

  for (const [cmd, kind, what, desc] of [
    [
      'critique',
      'critique-board',
      'critique',
      'Critique a board (risks and fixes land as proposed doc items)',
    ],
    [
      'plan',
      'implementation-plan',
      'implementation plan',
      'Turn a board into an implementation plan (Markdown tickets + agent brief)',
    ],
  ] as const)
    board
      .command(cmd)
      .description(desc)
      .argument('<id>', 'board id (brd_…)')
      .option('--runtime <id>', 'mock | claude-code | anthropic-api (default: the configured one)')
      .option('--yes', 'confirm sending data off this machine without asking')
      .option('--json', 'machine-readable output')
      .action(onBoard(kind, what));
}
