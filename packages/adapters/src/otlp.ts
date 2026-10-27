import { startRun } from './run.ts';

/**
 * OTLP/JSON trace import (plan §2 OpenTelemetry row, §15 Phase 4): a documented subset, not a
 * collector. Input is an `ExportTraceServiceRequest` in OTLP/JSON (one document, or one per line as
 * written by the OpenTelemetry file exporter). Each trace becomes one run; each span becomes a
 * start and an end event. Anything outside the subset becomes a diagnostic and a capture gap on the
 * run: evidence is never dropped silently. Producer event ids derive from trace and span ids, so
 * importing the same trace again (or a file with late spans of it) dedupes into the same run.
 */
export interface OtlpDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  traceId?: string;
  spanId?: string;
}

export interface OtlpImportResult {
  runs: {
    runId: string;
    traceId: string;
    existing: boolean;
    spans: number;
    events: { accepted: number; duplicates: number; rejected: number };
    status: string;
  }[];
  diagnostics: OtlpDiagnostic[];
}

export const OTLP_LIMITS = {
  maxSpans: 20_000,
  maxAttributes: 64,
  maxValueChars: 500,
  maxSpanEvents: 20,
};

type AnyValue = Record<string, unknown>;
interface RawSpan {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  kind?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: unknown;
  events?: unknown;
  links?: unknown;
  status?: { code?: unknown; message?: unknown };
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  start: string;
  end?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
  events: { name: string; at?: string; attributes: Record<string, unknown> }[];
  links: number;
  error: boolean;
  ok: boolean;
  statusMessage?: string;
  service?: string;
}

const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

/** OTLP/JSON ids are hex; protobuf-JSON mappings sometimes emit base64 instead. */
function normalizeId(v: unknown, bytes: number): { id?: string; converted?: boolean } {
  if (typeof v !== 'string' || v === '') return {};
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(v)) return { id: v.toLowerCase() };
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === bytes && b.toString('base64').replace(/=+$/, '') === v.replace(/=+$/, ''))
      return { id: b.toString('hex'), converted: true };
  } catch {
    // fall through
  }
  return {};
}

function nanosToIso(v: unknown): { iso?: string; ms?: bigint } {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return {};
  try {
    const n = BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
    const ms = n / 1_000_000n;
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? {} : { iso: d.toISOString(), ms };
  } catch {
    return {};
  }
}

export function parseOtlpJson(text: string): {
  requests: unknown[];
  diagnostics: OtlpDiagnostic[];
} {
  const diagnostics: OtlpDiagnostic[] = [];
  const t = text.trim();
  if (!t)
    return {
      requests: [],
      diagnostics: [{ severity: 'error', code: 'empty', message: 'the file is empty' }],
    };
  if (!t.startsWith('{'))
    return {
      requests: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'not-otlp-json',
          message:
            'not OTLP/JSON: only the JSON encoding of trace exports is supported (not protobuf, logs or metrics)',
        },
      ],
    };
  try {
    return { requests: [JSON.parse(t)], diagnostics };
  } catch {
    // JSON lines (file exporter)
  }
  const requests: unknown[] = [];
  t.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      requests.push(JSON.parse(line));
    } catch {
      diagnostics.push({
        severity: 'warning',
        code: 'bad-line',
        message: `line ${i + 1} is not valid JSON and was skipped`,
      });
    }
  });
  return { requests, diagnostics };
}

export function extractSpans(requests: unknown[]): {
  spans: Span[];
  diagnostics: OtlpDiagnostic[];
} {
  const diagnostics: OtlpDiagnostic[] = [];
  const spans: Span[] = [];
  const counts = new Map<string, number>();
  const note = (d: OtlpDiagnostic) => {
    // repeated per-span findings are summarized, not listed thousands of times
    const n = (counts.get(d.code) ?? 0) + 1;
    counts.set(d.code, n);
    if (n <= 20) diagnostics.push(d);
  };
  const attrValue = (
    v: AnyValue | undefined,
    ctx: { traceId?: string; spanId?: string },
  ): unknown => {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return String(v.stringValue).slice(0, OTLP_LIMITS.maxValueChars);
    if ('boolValue' in v) return Boolean(v.boolValue);
    if ('intValue' in v) return Number(v.intValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('arrayValue' in v)
      return ((v.arrayValue as { values?: AnyValue[] })?.values ?? [])
        .slice(0, 50)
        .map((x) => attrValue(x, ctx));
    if ('kvlistValue' in v) return attrs((v.kvlistValue as { values?: unknown })?.values, ctx);
    if ('bytesValue' in v) {
      note({
        severity: 'warning',
        code: 'bytes-attribute',
        message: 'bytes attribute values are not imported (shown as [bytes omitted])',
        ...ctx,
      });
      return '[bytes omitted]';
    }
    return null;
  };
  const attrs = (
    list: unknown,
    ctx: { traceId?: string; spanId?: string },
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!Array.isArray(list)) return out;
    for (const a of list.slice(0, OTLP_LIMITS.maxAttributes) as {
      key?: unknown;
      value?: AnyValue;
    }[])
      if (typeof a?.key === 'string') out[a.key] = attrValue(a.value, ctx);
    if (list.length > OTLP_LIMITS.maxAttributes)
      note({
        severity: 'warning',
        code: 'attributes-truncated',
        message: `only the first ${OTLP_LIMITS.maxAttributes} attributes of a span are kept`,
        ...ctx,
      });
    return out;
  };

  for (const req of requests) {
    const rs = (req as { resourceSpans?: unknown })?.resourceSpans;
    if (!Array.isArray(rs)) {
      if (req && typeof req === 'object' && ('resourceLogs' in req || 'resourceMetrics' in req))
        note({
          severity: 'error',
          code: 'not-traces',
          message: 'logs and metrics exports are not supported; only traces',
        });
      else
        note({
          severity: 'error',
          code: 'no-resource-spans',
          message: 'a document has no resourceSpans and was skipped',
        });
      continue;
    }
    for (const r of rs as {
      resource?: { attributes?: unknown };
      scopeSpans?: unknown;
      instrumentationLibrarySpans?: unknown;
    }[]) {
      const resource = attrs(r.resource?.attributes, {});
      const scopes = (
        Array.isArray(r.scopeSpans)
          ? r.scopeSpans
          : Array.isArray(r.instrumentationLibrarySpans)
            ? r.instrumentationLibrarySpans
            : []
      ) as { spans?: unknown }[];
      for (const sc of scopes) {
        for (const raw of (Array.isArray(sc.spans) ? sc.spans : []) as RawSpan[]) {
          if (spans.length >= OTLP_LIMITS.maxSpans) {
            note({
              severity: 'error',
              code: 'too-many-spans',
              message: `only the first ${OTLP_LIMITS.maxSpans} spans are imported`,
            });
            continue;
          }
          const tid = normalizeId(raw.traceId, 16);
          const sid = normalizeId(raw.spanId, 8);
          const ctx = { traceId: tid.id, spanId: sid.id };
          if (!tid.id || !sid.id) {
            note({
              severity: 'warning',
              code: 'bad-id',
              message: `span "${String(raw.name ?? '?')}" has an invalid trace or span id and was skipped`,
              ...ctx,
            });
            continue;
          }
          if (tid.converted || sid.converted)
            note({
              severity: 'info',
              code: 'base64-ids',
              message: 'base64 trace/span ids were converted to hex (OTLP/JSON specifies hex)',
              ...ctx,
            });
          const pid = raw.parentSpanId ? normalizeId(raw.parentSpanId, 8).id : undefined;
          const start = nanosToIso(raw.startTimeUnixNano);
          if (!start.iso) {
            note({
              severity: 'warning',
              code: 'no-start-time',
              message: `span "${String(raw.name ?? '?')}" has no start time and was skipped`,
              ...ctx,
            });
            continue;
          }
          const end = nanosToIso(raw.endTimeUnixNano);
          if (!end.iso)
            note({
              severity: 'warning',
              code: 'no-end-time',
              message: `span "${String(raw.name ?? '?')}" has no end time; it is imported as unfinished`,
              ...ctx,
            });
          const code = raw.status?.code;
          const links = Array.isArray(raw.links) ? raw.links.length : 0;
          if (links)
            note({
              severity: 'info',
              code: 'links-counted',
              message: 'span links are counted but not imported as relations',
              ...ctx,
            });
          const evs = Array.isArray(raw.events)
            ? (raw.events as { name?: unknown; timeUnixNano?: unknown; attributes?: unknown }[])
            : [];
          if (evs.length > OTLP_LIMITS.maxSpanEvents)
            note({
              severity: 'warning',
              code: 'span-events-truncated',
              message: `only the first ${OTLP_LIMITS.maxSpanEvents} events of a span are kept`,
              ...ctx,
            });
          spans.push({
            traceId: tid.id,
            spanId: sid.id,
            parentSpanId: pid,
            name: String(raw.name ?? '(unnamed span)').slice(0, 200),
            kind:
              typeof raw.kind === 'number'
                ? (KINDS[raw.kind] ?? 'unspecified')
                : String(raw.kind ?? 'unspecified')
                    .replace(/^SPAN_KIND_/, '')
                    .toLowerCase(),
            start: start.iso,
            end: end.iso,
            durationMs:
              start.ms !== undefined && end.ms !== undefined
                ? Number(end.ms - start.ms)
                : undefined,
            attributes: attrs(raw.attributes, ctx),
            events: evs.slice(0, OTLP_LIMITS.maxSpanEvents).map((e) => ({
              name: String(e.name ?? ''),
              at: nanosToIso(e.timeUnixNano).iso,
              attributes: attrs(e.attributes, ctx),
            })),
            links,
            error: code === 2 || code === 'STATUS_CODE_ERROR',
            ok: code === 1 || code === 'STATUS_CODE_OK',
            statusMessage:
              typeof raw.status?.message === 'string'
                ? raw.status.message.slice(0, 500)
                : undefined,
            service:
              typeof resource['service.name'] === 'string'
                ? (resource['service.name'] as string)
                : undefined,
          });
        }
      }
    }
  }
  for (const [code, n] of counts)
    if (n > 20)
      diagnostics.push({
        severity: 'info',
        code,
        message: `${n - 20} more "${code}" findings not listed`,
      });
  return { spans, diagnostics };
}

const toolName = (s: Span) =>
  (typeof s.attributes['gen_ai.tool.name'] === 'string' &&
    (s.attributes['gen_ai.tool.name'] as string)) ||
  (s.attributes['gen_ai.operation.name'] === 'execute_tool'
    ? s.name.replace(/^execute_tool\s*/, '') || s.name
    : undefined);

export async function importOtlp(o: {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  text: string;
  source?: string;
}): Promise<OtlpImportResult> {
  const parsed = parseOtlpJson(o.text);
  const { spans, diagnostics } = extractSpans(parsed.requests);
  diagnostics.unshift(...parsed.diagnostics);
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  const result: OtlpImportResult = { runs: [], diagnostics };

  for (const [traceId, list] of byTrace) {
    const ids = new Set(list.map((s) => s.spanId));
    const roots = list.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
    for (const s of roots)
      if (s.parentSpanId)
        diagnostics.push({
          severity: 'info',
          code: 'orphan-span',
          message: `span "${s.name}" names a parent that is not in this file (kept as a top-level step; a later import can supply it)`,
          traceId,
          spanId: s.spanId,
        });
    const traceDiagnostics = diagnostics.filter(
      (d) => d.traceId === traceId && d.severity !== 'info',
    );
    const first = [...list].sort((a, b) => a.start.localeCompare(b.start))[0]!;
    const root = roots.find((s) => !s.parentSpanId) ?? first;
    const { client, runId, existing } = await startRun({
      daemon: o.daemon,
      rootPath: o.rootPath,
      adapter: 'otlp',
      producerId: 'otlp',
      binding: 'none',
      externalRef: `otlp:${traceId}`,
      startAt: first.start,
      commandSummary: `${root.service ? `${root.service}: ` : ''}${root.name}`,
      environmentSummary: { importedFrom: o.source ?? 'otlp-json', traceId },
      instrumentationCapabilities: ['otlp-spans'],
    });

    // parents first, so each start event can name its parent's stored start event
    const depth = (s: Span) => {
      let d = 0;
      let cur: Span | undefined = s;
      const bySpan = new Map(list.map((x) => [x.spanId, x]));
      while (cur?.parentSpanId && bySpan.has(cur.parentSpanId) && d < 200) {
        cur = bySpan.get(cur.parentSpanId);
        d++;
      }
      return d;
    };
    const levels = new Map<number, Span[]>();
    for (const s of list) levels.set(depth(s), [...(levels.get(depth(s)) ?? []), s]);
    const startIds = new Map<string, string>();
    const totals = { accepted: 0, duplicates: 0, rejected: 0 };
    for (const lvl of [...levels.keys()].sort((a, b) => a - b)) {
      const batch = levels
        .get(lvl)!
        .sort((a, b) => a.start.localeCompare(b.start) || a.spanId.localeCompare(b.spanId));
      const r = await client.sendBatch(
        batch.map((s) => {
          const tool = toolName(s);
          return {
            producerEventId: `${traceId}:${s.spanId}:start`,
            type: tool ? 'tool.call.requested' : 'step.started',
            occurredAt: s.start,
            traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            parentEventId: s.parentSpanId ? startIds.get(s.parentSpanId) : undefined,
            payload: {
              name: s.name,
              ...(tool ? { tool } : {}),
              kind: s.kind,
              service: s.service,
              attributes: s.attributes,
              links: s.links || undefined,
            },
          };
        }),
      );
      batch.forEach((s, i) => r.ids[i] && startIds.set(s.spanId, r.ids[i]!));
      totals.accepted += r.accepted;
      totals.duplicates += r.duplicates;
      totals.rejected += r.rejected.length;
    }
    const ends = list.filter((s) => s.end);
    const r = await client.sendBatch(
      ends.map((s) => {
        const tool = toolName(s);
        return {
          producerEventId: `${traceId}:${s.spanId}:end`,
          type: tool ? 'tool.call.completed' : s.error ? 'step.failed' : 'step.completed',
          occurredAt: s.end!,
          traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          parentEventId: startIds.get(s.spanId),
          payload: {
            name: s.name,
            ...(tool ? { tool, ok: !s.error } : {}),
            durationMs: s.durationMs,
            status: s.error ? 'error' : s.ok ? 'ok' : 'unset',
            error: s.error ? (s.statusMessage ?? 'span status ERROR') : undefined,
            events: s.events.length ? s.events : undefined,
          },
        };
      }),
    );
    totals.accepted += r.accepted;
    totals.duplicates += r.duplicates;
    totals.rejected += r.rejected.length;

    // OTLP has no run outcome: an ERROR root fails it, an OK root succeeds, UNSET stays unknown
    // orphans (parent missing from the file) are not the trace's root and do not decide its outcome
    const top = list.filter((s) => !s.parentSpanId);
    const status = top.some((s) => s.error)
      ? 'failed'
      : top.length && top.every((s) => s.ok && s.end)
        ? 'succeeded'
        : 'unknown';
    const gaps = traceDiagnostics
      .slice(0, 20)
      .map((d) => ({ kind: `otlp-${d.code}`, detail: d.message }));
    const endAt = list.reduce<string | undefined>(
      (m, s) => (s.end && (!m || s.end > m) ? s.end : m),
      undefined,
    );
    const fin = await client.finish(status, { captureGaps: gaps, endAt }).then(
      () => status,
      (e: Error) => {
        // a re-import keeps the first outcome; the new events were still added
        diagnostics.push({
          severity: 'info',
          code: 'already-finished',
          message: `run ${runId} kept its earlier outcome (${e.message.slice(0, 120)})`,
          traceId,
        });
        return 'kept';
      },
    );
    result.runs.push({ runId, traceId, existing, spans: list.length, events: totals, status: fin });
  }
  if (spans.length === 0 && !diagnostics.some((d) => d.severity === 'error'))
    diagnostics.push({ severity: 'error', code: 'no-spans', message: 'no spans were found' });
  return result;
}
