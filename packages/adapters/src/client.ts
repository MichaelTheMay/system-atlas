import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Minimal client for the Atlas ingestion protocol (docs/evidence.md), shared by the process wrapper,
 * the SDK for instrumented programs and the Playwright capture helper. It holds only a run-scoped
 * token, never the daemon token.
 */
export interface IngestTarget {
  baseUrl: string;
  runId: string;
  runToken: string;
}

export interface EventDraft {
  type: string;
  payload?: Record<string, unknown>;
  entityRefs?: string[];
  artifactIds?: string[];
  parentEventId?: string;
  causalEventIds?: string[];
  occurredAt?: string;
}

export interface ArtifactDraft {
  logicalName: string;
  mediaType?: string;
  role?: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

const MEDIA_BY_EXT: Record<string, string> = {
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function guessMediaType(path: string): string {
  return (
    MEDIA_BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
  );
}

export class IngestClient {
  readonly target: IngestTarget;
  readonly producerId: string;
  private seq = 0;
  private queue: (EventDraft & {
    sequence: number;
    producerEventId: string;
    occurredAt: string;
  })[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private failures: string[] = [];

  constructor(target: IngestTarget, producerId: string) {
    this.target = target;
    this.producerId = producerId;
  }

  private headers(extra: Record<string, string> = {}) {
    return { 'x-atlas-run-token': this.target.runToken, ...extra };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    const res = await fetch(`${this.target.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { 'content-type': contentType } : {}),
      body:
        body === undefined
          ? undefined
          : contentType === 'application/json'
            ? JSON.stringify(body)
            : (body as RequestInit['body']),
      ...(contentType === 'application/octet-stream' ? { duplex: 'half' } : {}),
    } as RequestInit);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Queue an event; returns its producer event id. Events keep producer order via `sequence`. */
  emit(e: EventDraft): string {
    const sequence = this.seq++;
    const producerEventId = `${this.target.runId}:${this.producerId}:${sequence}`;
    this.queue.push({
      ...e,
      sequence,
      producerEventId,
      occurredAt: e.occurredAt ?? new Date().toISOString(),
    });
    return producerEventId;
  }

  /** Send queued events (batched, in order). Safe to call concurrently. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      while (this.queue.length) {
        const batch = this.queue
          .splice(0, 500)
          .map((e) => ({ ...e, producerId: this.producerId, payload: e.payload ?? {} }));
        try {
          const r = await this.request<{ rejected: { index: number; error: string }[] }>(
            'POST',
            `/api/v1/runs/${this.target.runId}/events`,
            batch,
          );
          for (const x of r.rejected)
            this.failures.push(`event ${batch[x.index]?.type}: ${x.error}`);
        } catch (err) {
          this.failures.push(String((err as Error).message));
        }
      }
    });
    return this.flushing;
  }

  /** Send one event now (after anything queued) and return the stored event id, for linking. */
  async event(e: EventDraft): Promise<string | undefined> {
    await this.flush();
    const sequence = this.seq++;
    const body = [
      {
        ...e,
        sequence,
        producerEventId: `${this.target.runId}:${this.producerId}:${sequence}`,
        producerId: this.producerId,
        occurredAt: e.occurredAt ?? new Date().toISOString(),
        payload: e.payload ?? {},
      },
    ];
    try {
      const r = await this.request<{
        accepted: { id: string }[];
        duplicates: { id: string }[];
        rejected: { error: string }[];
      }>('POST', `/api/v1/runs/${this.target.runId}/events`, body);
      if (r.rejected.length) this.failures.push(`event ${e.type}: ${r.rejected[0]!.error}`);
      return r.accepted[0]?.id ?? r.duplicates[0]?.id;
    } catch (err) {
      this.failures.push(String((err as Error).message));
      return undefined;
    }
  }

  /**
   * Send events with caller-chosen producer event ids (importers: stable ids make re-imports
   * dedupe). Returns the stored id per input (accepted or the earlier duplicate) or undefined
   * with the rejection recorded.
   */
  async sendBatch(
    events: (EventDraft & { producerEventId: string; sequence?: number })[],
  ): Promise<{
    ids: (string | undefined)[];
    accepted: number;
    duplicates: number;
    rejected: string[];
  }> {
    const ids: (string | undefined)[] = new Array(events.length).fill(undefined);
    let accepted = 0;
    let duplicates = 0;
    const rejected: string[] = [];
    for (let start = 0; start < events.length; start += 500) {
      const chunk = events.slice(start, start + 500).map((e) => ({
        ...e,
        producerId: this.producerId,
        occurredAt: e.occurredAt ?? new Date().toISOString(),
        payload: e.payload ?? {},
      }));
      type R = {
        accepted: { index: number; id: string }[];
        duplicates: { index: number; id: string }[];
        rejected: { index: number; error: string }[];
      };
      // the route answers 400 when every event of a batch is rejected; that is still per-event data
      const res = await fetch(`${this.target.baseUrl}/api/v1/runs/${this.target.runId}/events`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(chunk),
      });
      const r = (await res.json()) as Partial<R> & { error?: string };
      if (!r.accepted) {
        for (const e of chunk) {
          const msg = `event ${e.type} ${e.producerEventId}: ${r.error ?? `HTTP ${res.status}`}`;
          rejected.push(msg);
          this.failures.push(msg);
        }
        continue;
      }
      for (const a of r.accepted) ids[start + a.index] = a.id;
      for (const d of r.duplicates ?? []) ids[start + d.index] = d.id;
      accepted += r.accepted.length;
      duplicates += r.duplicates?.length ?? 0;
      for (const x of r.rejected ?? []) {
        const msg = `event ${chunk[x.index]?.type} ${chunk[x.index]?.producerEventId}: ${x.error}`;
        rejected.push(msg);
        this.failures.push(msg);
      }
    }
    return { ids, accepted, duplicates, rejected };
  }

  /** Upload a file as an artifact: hash locally, reserve, stream bytes (skipped when deduplicated). */
  async uploadFile(
    path: string,
    draft: Partial<ArtifactDraft> = {},
  ): Promise<{ id: string; bytesState: string }> {
    const size = statSync(path).size;
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path)
        .on('data', (c) => h.update(c))
        .on('error', reject)
        .on('end', () => resolve(h.digest('hex')));
    });
    return this.upload(
      createReadStream(path),
      {
        logicalName: draft.logicalName ?? basename(path),
        mediaType: draft.mediaType ?? guessMediaType(path),
        role: draft.role,
        eventId: draft.eventId,
        metadata: draft.metadata,
      },
      { sha256, byteLength: size },
    );
  }

  async uploadBytes(
    bytes: Uint8Array,
    draft: ArtifactDraft,
  ): Promise<{ id: string; bytesState: string }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.upload(bytes, draft, { sha256, byteLength: bytes.byteLength });
  }

  private async upload(
    body: unknown,
    draft: ArtifactDraft,
    integrity: { sha256: string; byteLength: number },
  ) {
    const r = await this.request<{
      artifact: { id: string; bytesState: string };
      uploadRequired: boolean;
      uploadPath?: string;
    }>('POST', `/api/v1/runs/${this.target.runId}/artifacts`, {
      ...draft,
      ...integrity,
      metadata: draft.metadata ?? {},
    });
    if (!r.uploadRequired || !r.uploadPath) return r.artifact;
    const stored = await this.request<{ id: string; bytesState: string }>(
      'PUT',
      r.uploadPath,
      body,
      'application/octet-stream',
    );
    return stored;
  }

  /** Reserve an artifact that will not arrive (capture failed) so it shows as missing. */
  async declareMissing(draft: ArtifactDraft, reason: string): Promise<string> {
    const r = await this.request<{ artifact: { id: string } }>(
      'POST',
      `/api/v1/runs/${this.target.runId}/artifacts`,
      { ...draft, metadata: draft.metadata ?? {} },
    );
    await this.request('POST', `/api/v1/artifacts/${r.artifact.id}/missing`, { reason });
    return r.artifact.id;
  }

  async finish(
    status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    extra: {
      exitCode?: number;
      signal?: string;
      captureGaps?: { kind: string; detail: string }[];
      /** When the run really ended (imports); defaults to now. */
      endAt?: string;
    } = {},
  ) {
    await this.flush();
    const gaps = [
      ...(extra.captureGaps ?? []),
      ...this.failures
        .slice(0, 20)
        .map((detail) => ({ kind: 'ingestion-error', detail: detail.slice(0, 500) })),
    ];
    return this.request('POST', `/api/v1/runs/${this.target.runId}/finish`, {
      status,
      exitCode: extra.exitCode,
      signal: extra.signal,
      endAt: extra.endAt,
      captureGaps: gaps.length ? gaps : undefined,
    });
  }

  /** Ingestion problems seen so far (reported as capture gaps at finish). */
  errors(): string[] {
    return [...this.failures];
  }
}

/** Environment handed to instrumented child processes: run-scoped, never the daemon token. */
export function childEnv(t: IngestTarget): Record<string, string> {
  return { ATLAS_INGEST_URL: t.baseUrl, ATLAS_RUN_ID: t.runId, ATLAS_RUN_TOKEN: t.runToken };
}

export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): IngestTarget | undefined {
  if (!env.ATLAS_INGEST_URL || !env.ATLAS_RUN_ID || !env.ATLAS_RUN_TOKEN) return undefined;
  return { baseUrl: env.ATLAS_INGEST_URL, runId: env.ATLAS_RUN_ID, runToken: env.ATLAS_RUN_TOKEN };
}
