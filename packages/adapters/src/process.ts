import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { redactValue } from '@atlas/schema';
import { childEnv } from './client.ts';
import { startRun } from './run.ts';

export interface RunProcessOptions {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  cwd: string;
  command: string;
  args: string[];
  /** Declared outputs (files or directories), relative to cwd. */
  outputs?: string[];
  name?: string;
  echo?: boolean;
  /** Inline stdout/stderr sent as events; full logs are always uploaded as artifacts. */
  inlineLogCapBytes?: number;
  signal?: AbortSignal;
}

export interface RunProcessResult {
  runId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  snapshotBound: boolean;
  outputs: { path: string; state: 'uploaded' | 'missing'; producedDuringRun?: boolean }[];
  ingestionErrors: string[];
}

const CHUNK = 16 * 1024;

/**
 * `atlas run -- <command>` (plan §10): a user-initiated command, argv only (no shell), with logs,
 * exit/signal/cancellation and declared outputs recorded against the run's source snapshot.
 */
export async function runProcess(o: RunProcessOptions): Promise<RunProcessResult> {
  const argv = [o.command, ...o.args];
  const { client, target, snapshotBound, runId } = await startRun({
    daemon: o.daemon,
    rootPath: o.rootPath,
    adapter: 'process',
    // the program's base name: absolute interpreter paths are noise and leak local layout
    commandSummary:
      (o.name ? `${o.name}: ` : '') + [basename(o.command), ...o.args].join(' ').slice(0, 1500),
    environmentSummary: {
      platform: process.platform,
      node: process.version,
      cwd: relative(o.rootPath, o.cwd) || '.',
      shell: false,
    },
    instrumentationCapabilities: ['stdout', 'stderr', 'exit', 'declared-outputs', 'sdk-env'],
    producerId: 'atlas-run',
  });
  const started = Date.now();
  const startedEvent = await client.event({
    type: 'run.started',
    payload: { argv: redactValue(argv).value, name: o.name ?? null },
  });

  const logDir = mkdtempSync(join(tmpdir(), 'atlas-run-logs-'));
  const files = { stdout: join(logDir, 'stdout.log'), stderr: join(logDir, 'stderr.log') };
  const sinks = {
    stdout: createWriteStream(files.stdout),
    stderr: createWriteStream(files.stderr),
  };
  const cap = o.inlineLogCapBytes ?? 10 * 1024 * 1024;
  let inline = 0;
  let truncated = false;
  const offsets = { stdout: 0, stderr: 0 };

  const child = spawn(o.command, o.args, {
    cwd: o.cwd,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...childEnv(target) },
  });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    child.kill('SIGINT');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
  };
  o.signal?.addEventListener('abort', cancel, { once: true });

  const timer = setInterval(() => void client.flush(), 250);
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (buf: Buffer) => {
      sinks[stream].write(buf);
      if (o.echo) (stream === 'stdout' ? process.stdout : process.stderr).write(buf);
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, i + CHUNK);
        if (inline + part.length > cap) {
          if (!truncated) {
            truncated = true;
            client.emit({
              type: 'capture.gap',
              payload: {
                kind: 'log-truncated',
                detail: `inline log limit of ${cap} bytes reached; full logs are attached as artifacts`,
              },
            });
          }
          continue;
        }
        inline += part.length;
        client.emit({
          type: `command.${stream}`,
          payload: { stream, offset: offsets[stream], text: part.toString('utf8') },
          parentEventId: startedEvent,
        });
      }
      offsets[stream] += buf.length;
    });
  }

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((done) => {
    child.on('error', (error) => done({ code: null, signal: null, error }));
    child.on('close', (code, signal) => done({ code, signal }));
  });
  clearInterval(timer);
  o.signal?.removeEventListener('abort', cancel);
  await Promise.all([
    new Promise((r) => sinks.stdout.end(r)),
    new Promise((r) => sinks.stderr.end(r)),
  ]);

  const durationMs = Date.now() - started;
  const exitEvent = await client.event({
    type: 'command.exit',
    payload: {
      exitCode: exit.code,
      signal: exit.signal,
      durationMs,
      spawnError: exit.error ? exit.error.message : null,
      bytes: { ...offsets },
    },
    parentEventId: startedEvent,
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    if (statSync(files[stream]).size > 0)
      await client
        .uploadFile(files[stream], {
          logicalName: `${stream}.log`,
          mediaType: 'text/plain',
          role: 'log',
          eventId: exitEvent,
        })
        .catch(() => undefined);
  }
  rmSync(logDir, { recursive: true, force: true });

  const outputs: RunProcessResult['outputs'] = [];
  for (const declared of o.outputs ?? []) {
    const abs = resolve(o.cwd, declared);
    const files = existsSync(abs)
      ? statSync(abs).isDirectory()
        ? listFiles(abs).map((f) => join(abs, f))
        : [abs]
      : [];
    if (files.length === 0) {
      await client.declareMissing(
        {
          logicalName: declared,
          role: 'output-file',
          eventId: exitEvent,
          metadata: { declaredOutput: declared },
        },
        'declared output was not produced',
      );
      outputs.push({ path: declared, state: 'missing' });
      continue;
    }
    for (const f of files) {
      const rel = relative(o.cwd, f);
      // only files written during the run are claimed as produced by it; older files are flagged
      const producedDuringRun = statSync(f).mtimeMs >= started - 1000;
      const produced = await client.event({
        type: 'file.produced',
        payload: { path: rel, producedDuringRun },
        parentEventId: exitEvent,
      });
      try {
        await client.uploadFile(f, {
          logicalName: rel,
          role: 'output-file',
          eventId: produced,
          metadata: { declaredOutput: declared, producedDuringRun },
        });
        outputs.push({ path: rel, state: 'uploaded', producedDuringRun });
      } catch {
        outputs.push({ path: rel, state: 'missing', producedDuringRun });
      }
    }
  }

  const status: RunProcessResult['status'] = cancelled
    ? 'cancelled'
    : exit.code === 0
      ? 'succeeded'
      : 'failed';
  await client.finish(status, {
    exitCode: exit.code ?? undefined,
    signal: exit.signal ?? undefined,
    captureGaps: exit.error ? [{ kind: 'spawn-failed', detail: exit.error.message }] : undefined,
  });
  return {
    runId,
    status,
    exitCode: exit.code,
    signal: exit.signal,
    snapshotBound,
    outputs,
    ingestionErrors: client.errors(),
  };
}

function listFiles(dir: string, prefix = '', out: string[] = [], limit = 200): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (out.length >= limit) break;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(join(dir, e.name), rel, out, limit);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
