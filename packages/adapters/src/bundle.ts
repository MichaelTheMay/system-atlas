import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { guessMediaType } from './client.ts';
import { startRun } from './run.ts';

/**
 * Atlas run bundle v1: a directory the user approves for import, holding `atlas-run.json` and
 * the files it lists. Imported runs are never bound to the current tree. Event ids are local to the
 * bundle and become stable producer event ids, so importing the same bundle again dedupes, and a
 * newer copy with more events adds only those. Files must resolve (after symlinks) inside the
 * bundle; anything else is reported, and declared-but-absent files are recorded as missing.
 */
export const BUNDLE_MANIFEST = 'atlas-run.json';

const LocalId = z.string().min(1).max(150);
export const RunBundle = z.object({
  format: z.literal('atlas-run-bundle'),
  version: z.literal(1),
  producer: z.string().min(1).max(100),
  run: z.object({
    key: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(500),
    adapter: z.string().min(1).max(100).default('bundle'),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    endedAt: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']).default('unknown'),
  }),
  events: z
    .array(
      z.object({
        id: LocalId,
        type: z.string().min(1).max(100),
        occurredAt: z.iso.datetime({ offset: true }),
        parent: LocalId.optional(),
        payload: z.record(z.string(), z.unknown()).default({}),
        entityRefs: z.array(z.string()).max(50).optional(),
      }),
    )
    .max(50_000)
    .default([]),
  artifacts: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        logicalName: z.string().min(1).max(300).optional(),
        mediaType: z.string().max(100).optional(),
        role: z.string().max(40).optional(),
        event: LocalId.optional(),
      }),
    )
    .max(5_000)
    .default([]),
});
export type RunBundle = z.input<typeof RunBundle>;

export interface BundleImportResult {
  runId?: string;
  existing: boolean;
  events: { accepted: number; duplicates: number; rejected: number };
  artifacts: { uploaded: number; missing: number; refused: number };
  diagnostics: { severity: 'info' | 'warning' | 'error'; message: string }[];
}

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export async function importBundle(o: {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  bundleDir: string;
}): Promise<BundleImportResult> {
  const out: BundleImportResult = {
    existing: false,
    events: { accepted: 0, duplicates: 0, rejected: 0 },
    artifacts: { uploaded: 0, missing: 0, refused: 0 },
    diagnostics: [],
  };
  const dir = realpathSync(o.bundleDir);
  let raw: string;
  try {
    raw = readFileSync(join(dir, BUNDLE_MANIFEST), 'utf8');
  } catch {
    out.diagnostics.push({ severity: 'error', message: `${BUNDLE_MANIFEST} not found in ${dir}` });
    return out;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    out.diagnostics.push({ severity: 'error', message: `${BUNDLE_MANIFEST} is not valid JSON` });
    return out;
  }
  const parsed = RunBundle.safeParse(json);
  if (!parsed.success) {
    out.diagnostics.push(
      ...parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ severity: 'error' as const, message: `${i.path.join('.')}: ${i.message}` })),
    );
    return out;
  }
  const b = parsed.data;
  const ids = new Set<string>();
  for (const e of b.events) {
    if (ids.has(e.id))
      out.diagnostics.push({
        severity: 'warning',
        message: `duplicate local event id ${e.id}; the later one dedupes into the first`,
      });
    ids.add(e.id);
  }
  const key =
    b.run.key ??
    createHash('sha256')
      .update(`${b.producer}\u0000${b.run.name}\u0000${b.run.startedAt ?? ''}`)
      .digest('hex')
      .slice(0, 32);
  const { client, runId, existing } = await startRun({
    daemon: o.daemon,
    rootPath: o.rootPath,
    adapter: b.run.adapter,
    producerId: `bundle:${b.producer}`,
    binding: 'none',
    externalRef: `bundle:${b.producer}:${key}`,
    startAt: b.run.startedAt,
    commandSummary: b.run.name,
    environmentSummary: { importedFrom: 'atlas-run-bundle', producer: b.producer },
    instrumentationCapabilities: ['imported-bundle'],
  });
  out.runId = runId;
  out.existing = existing;

  // parents before children, so each event can point at its parent's stored id
  const byId = new Map(b.events.map((e) => [e.id, e]));
  const depth = (id: string) => {
    let d = 0;
    let cur = byId.get(id);
    while (cur?.parent && byId.has(cur.parent) && d < 500) {
      cur = byId.get(cur.parent);
      d++;
    }
    return d;
  };
  for (const e of b.events)
    if (e.parent && !byId.has(e.parent))
      out.diagnostics.push({
        severity: 'warning',
        message: `event ${e.id} names parent ${e.parent}, which is not in the bundle`,
      });
  const stored = new Map<string, string>();
  const levels = new Map<number, typeof b.events>();
  for (const e of b.events) levels.set(depth(e.id), [...(levels.get(depth(e.id)) ?? []), e]);
  for (const lvl of [...levels.keys()].sort((a, c) => a - c)) {
    const batch = levels.get(lvl)!;
    const r = await client.sendBatch(
      batch.map((e) => ({
        producerEventId: e.id,
        sequence: b.events.indexOf(e),
        type: e.type,
        occurredAt: e.occurredAt,
        parentEventId: e.parent ? stored.get(e.parent) : undefined,
        payload: e.payload,
        entityRefs: e.entityRefs,
      })),
    );
    batch.forEach((e, i) => r.ids[i] && stored.set(e.id, r.ids[i]!));
    out.events.accepted += r.accepted;
    out.events.duplicates += r.duplicates;
    out.events.rejected += r.rejected.length;
    for (const m of r.rejected.slice(0, 20))
      out.diagnostics.push({ severity: 'warning', message: m });
  }

  for (const a of b.artifacts) {
    const draft = {
      logicalName: a.logicalName ?? a.path,
      mediaType: a.mediaType ?? guessMediaType(a.path),
      role: a.role ?? 'output-file',
      eventId: a.event ? stored.get(a.event) : undefined,
    };
    if (isAbsolute(a.path) || a.path.split(/[\\/]/).includes('..')) {
      out.artifacts.refused++;
      out.diagnostics.push({
        severity: 'warning',
        message: `artifact path ${a.path} leaves the bundle; refused`,
      });
      await client.declareMissing(draft, 'refused: path outside the bundle');
      continue;
    }
    let real: string;
    try {
      real = realpathSync(join(dir, a.path));
    } catch {
      out.artifacts.missing++;
      await client.declareMissing(draft, 'listed in the bundle but not present');
      continue;
    }
    if (!real.startsWith(dir + sep) || !statSync(real).isFile()) {
      out.artifacts.refused++;
      out.diagnostics.push({
        severity: 'warning',
        message: `artifact ${a.path} resolves outside the bundle or is not a file; refused`,
      });
      await client.declareMissing(draft, 'refused: resolves outside the bundle');
      continue;
    }
    if (statSync(real).size > MAX_ARTIFACT_BYTES) {
      out.artifacts.refused++;
      out.diagnostics.push({
        severity: 'warning',
        message: `artifact ${a.path} is larger than 100 MiB; refused`,
      });
      await client.declareMissing(draft, 'refused: larger than the artifact limit');
      continue;
    }
    await client.uploadFile(real, draft);
    out.artifacts.uploaded++;
  }

  const gaps = out.diagnostics
    .filter((d) => d.severity !== 'info')
    .slice(0, 20)
    .map((d) => ({ kind: 'bundle-import', detail: d.message.slice(0, 500) }));
  const endAt =
    b.run.endedAt ??
    b.events.reduce<string | undefined>(
      (m, e) => (!m || e.occurredAt > m ? e.occurredAt : m),
      undefined,
    );
  await client.finish(b.run.status, { captureGaps: gaps, endAt }).catch((e: Error) => {
    out.diagnostics.push({
      severity: 'info',
      message: `the run kept its earlier outcome (${e.message.slice(0, 120)})`,
    });
  });
  return out;
}
