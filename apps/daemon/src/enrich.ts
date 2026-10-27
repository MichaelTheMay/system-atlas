import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createMockProvider,
  ENRICH_OUTPUT_SCHEMA_VERSION,
  type EvidenceBundle,
  type ExistingClaim,
  type ModelProvider,
  type ProposedClaim,
} from '@atlas/agent-api';
import { getLatestSnapshot, getWorktree, proposeClaims } from '@atlas/graph';
import { newId, redactExcerpt } from '@atlas/schema';
import type { Db } from '@atlas/store';
import type { EventBus } from './events.ts';
import { entityDetails, readSource } from './routes/inspect.ts';

/**
 * Optional model enrichment (plan §12). Off by default (`provider: none`). Requests are explicit
 * only: watcher scans and rescans never call a model. Bundles carry redacted, bounded excerpts.
 * Results are cached by input digest; usage is ledgered with estimated and reported numbers kept
 * apart; a daily token budget stops requests before they are sent; a newer request for the same
 * subject cancels the older one. Every proposed claim goes through the same validator as agent
 * proposals, so invented evidence is rejected and nothing becomes a supported fact.
 */
export const EnrichmentSettings = z.object({
  provider: z.enum(['none', 'mock', 'mock-adversarial']).default('none'),
  maxTokensPerDay: z.number().int().min(0).max(100_000_000).default(200_000),
  maxInputTokensPerRequest: z.number().int().min(200).max(200_000).default(6_000),
  maxOutputTokensPerRequest: z.number().int().min(50).max(50_000).default(1_000),
});
export type EnrichmentSettings = z.infer<typeof EnrichmentSettings>;

export type EnrichStatus =
  | 'disabled'
  | 'completed'
  | 'cached'
  | 'skipped-budget'
  | 'cancelled'
  | 'failed'
  | 'stale-precondition'
  | 'unknown-entity';

export interface EnrichOutcome {
  entityId: string;
  status: EnrichStatus;
  accepted: number;
  rejected: { index: number; reasons: string[] }[];
  detail?: string;
}

const SETTINGS_KEY = 'enrichment';
const MAX_EXCERPTS = 4;
const MAX_EXCERPT_LINES = 60;

export function defaultProviders(): Record<string, () => ModelProvider> {
  return {
    mock: () => createMockProvider(),
    'mock-adversarial': () => createMockProvider({ mode: 'adversarial' }),
  };
}

export class Enricher {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly providers: Record<string, () => ModelProvider>;
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    db: Db,
    bus: EventBus,
    providers: Record<string, () => ModelProvider> = defaultProviders(),
  ) {
    this.db = db;
    this.bus = bus;
    this.providers = providers;
  }

  settings(): EnrichmentSettings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get<{ value: string }>(SETTINGS_KEY);
    return EnrichmentSettings.parse(row ? JSON.parse(row.value) : {});
  }

  setSettings(
    patch: unknown,
  ): { ok: true; settings: EnrichmentSettings } | { ok: false; error: string } {
    const next = EnrichmentSettings.safeParse({ ...this.settings(), ...(patch as object) });
    if (!next.success)
      return { ok: false, error: next.error.issues[0]?.message ?? 'invalid settings' };
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(SETTINGS_KEY, JSON.stringify(next.data), new Date().toISOString());
    return { ok: true, settings: next.data };
  }

  /** Today's spend (UTC day): the larger of estimated and reported tokens per request. */
  usage(projectId: string) {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        'SELECT * FROM model_usage WHERE project_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC',
      )
      .all<Record<string, number | string | null>>(projectId, day);
    const spent = rows
      .filter((r) => r.status === 'completed' || r.status === 'cancelled' || r.status === 'failed')
      .reduce(
        (n, r) =>
          n +
          Math.max(
            Number(r.est_input_tokens) + Number(r.est_output_tokens),
            Number(r.reported_input_tokens ?? 0) + Number(r.reported_output_tokens ?? 0),
          ),
        0,
      );
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      day,
      tokensCounted: spent,
      estimated: rows.reduce(
        (n, r) => n + Number(r.est_input_tokens) + Number(r.est_output_tokens),
        0,
      ),
      reported: rows.reduce(
        (n, r) => n + Number(r.reported_input_tokens ?? 0) + Number(r.reported_output_tokens ?? 0),
        0,
      ),
      requests: count('completed'),
      cached: count('cached'),
      skippedBudget: count('skipped-budget'),
      cancelled: count('cancelled'),
      failed: count('failed'),
      recent: rows.slice(0, 20).map((r) => ({
        id: r.id,
        subjectId: r.subject_id,
        provider: r.provider,
        model: r.model,
        status: r.status,
        estimatedTokens: Number(r.est_input_tokens) + Number(r.est_output_tokens),
        reportedTokens:
          r.reported_input_tokens === null
            ? null
            : Number(r.reported_input_tokens) + Number(r.reported_output_tokens ?? 0),
        createdAt: r.created_at,
      })),
    };
  }

  async enrichEntities(worktreeId: string, entityIds: string[]): Promise<EnrichOutcome[]> {
    const out: EnrichOutcome[] = [];
    for (const id of entityIds) out.push(await this.enrichOne(worktreeId, id));
    return out;
  }

  private ledger(row: {
    projectId: string;
    subjectId: string;
    provider: ModelProvider;
    digest: string;
    status: string;
    estIn: number;
    estOut: number;
    reported?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
    detail?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO model_usage (id, project_id, subject_id, provider, model, digest, status, est_input_tokens, est_output_tokens,
           reported_input_tokens, reported_output_tokens, reported_cost_usd, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('usage'),
        row.projectId,
        row.subjectId,
        row.provider.id,
        row.provider.model,
        row.digest,
        row.status,
        row.estIn,
        row.estOut,
        row.reported?.inputTokens ?? null,
        row.reported?.outputTokens ?? null,
        row.reported?.costUsd ?? null,
        row.detail?.slice(0, 500) ?? null,
        new Date().toISOString(),
      );
  }

  private async bundleFor(
    snapshotId: string,
    entityId: string,
    maxChars: number,
  ): Promise<EvidenceBundle | undefined> {
    const d = entityDetails(this.db, snapshotId, entityId);
    if (!d) return undefined;
    const excerpts: EvidenceBundle['excerpts'] = [];
    let budget = maxChars - 2_000; // room for the structural part
    for (const ev of d.evidence as unknown as {
      id: string;
      repoRelativePath?: string;
      startLine?: number;
      endLine?: number;
    }[]) {
      if (excerpts.length >= MAX_EXCERPTS || budget <= 0) break;
      if (!ev.repoRelativePath || !ev.startLine) continue;
      const src = await readSource(this.db, snapshotId, ev.repoRelativePath);
      if (src.status !== 200 || !src.text) continue;
      const end = Math.min(ev.endLine ?? ev.startLine, ev.startLine + MAX_EXCERPT_LINES - 1);
      // redaction happens before anything can reach a provider
      const text = redactExcerpt(
        src.text
          .split('\n')
          .slice(ev.startLine - 1, end)
          .join('\n'),
      ).text.slice(0, Math.min(1_500, budget));
      budget -= text.length;
      excerpts.push({
        evidenceId: ev.id,
        path: ev.repoRelativePath,
        startLine: ev.startLine,
        endLine: end,
        text,
      });
    }
    const attrs = d.entity.attributes as { path?: unknown };
    return {
      snapshotId,
      subject: {
        id: String(d.entity.id),
        kind: String(d.entity.kind),
        displayName: String(d.entity.displayName),
        canonicalName: String(d.entity.canonicalName),
        path: typeof attrs.path === 'string' ? attrs.path : undefined,
      },
      owners: d.owners.map((o: { displayName: string }) => o.displayName),
      relations: (
        d.relations as {
          direction: 'in' | 'out';
          kind: string;
          other: { displayName: string };
          status: string;
        }[]
      )
        .slice(0, 30)
        .map((r) => ({
          direction: r.direction,
          kind: r.kind,
          other: r.other.displayName,
          status: r.status,
        })),
      excerpts,
    };
  }

  private async enrichOne(worktreeId: string, entityId: string): Promise<EnrichOutcome> {
    const base = { entityId, accepted: 0, rejected: [] as EnrichOutcome['rejected'] };
    const settings = this.settings();
    if (settings.provider === 'none')
      return { ...base, status: 'disabled', detail: 'no model provider is configured' };
    const make = this.providers[settings.provider];
    if (!make)
      return {
        ...base,
        status: 'disabled',
        detail: `provider ${settings.provider} is not available`,
      };
    const provider = make();
    const wt = getWorktree(this.db, worktreeId);
    const latest = wt && getLatestSnapshot(this.db, wt.id);
    if (!wt || !latest) return { ...base, status: 'unknown-entity', detail: 'no snapshot yet' };
    const snapshotId = latest.snapshot.id;
    const bundle = await this.bundleFor(
      snapshotId,
      entityId,
      settings.maxInputTokensPerRequest * 4,
    );
    if (!bundle) return { ...base, status: 'unknown-entity' };
    const existing: ExistingClaim[] = this.db
      .prepare(
        'SELECT predicate, origin, status, body FROM claims WHERE snapshot_id = ? AND subject_id = ?',
      )
      .all<{ predicate: string; origin: string; status: string; body: string }>(
        snapshotId,
        entityId,
      )
      .map((c) => ({
        predicate: c.predicate,
        origin: c.origin,
        status: c.status,
        value: (JSON.parse(c.body) as { value: unknown }).value,
      }));

    // the cache key is everything that determines the request, except existing claims (deduped on store)
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          bundle: { ...bundle, snapshotId: undefined },
          schema: ENRICH_OUTPUT_SCHEMA_VERSION,
          provider: provider.id,
          model: provider.model,
          prompt: provider.promptTemplateVersion,
        }),
      )
      .digest('hex');
    const estIn = Math.ceil(JSON.stringify(bundle).length / 4);
    const estOut = settings.maxOutputTokensPerRequest;
    const ledger = (
      status: string,
      reported?: Parameters<Enricher['ledger']>[0]['reported'],
      detail?: string,
    ) =>
      this.ledger({
        projectId: wt.projectId,
        subjectId: entityId,
        provider,
        digest,
        status,
        estIn: status === 'cached' || status === 'skipped-budget' ? 0 : estIn,
        estOut: status === 'cached' || status === 'skipped-budget' ? 0 : estOut,
        reported,
        detail,
      });

    let claims: ProposedClaim[];
    let status: EnrichStatus;
    let requestId: string | undefined;
    const hit = this.db
      .prepare('SELECT output FROM enrichment_cache WHERE digest = ?')
      .get<{ output: string }>(digest);
    if (hit) {
      claims = (JSON.parse(hit.output) as { claims: ProposedClaim[] }).claims;
      status = 'cached';
      ledger('cached');
    } else {
      if (this.usage(wt.projectId).tokensCounted + estIn + estOut > settings.maxTokensPerDay) {
        ledger(
          'skipped-budget',
          undefined,
          `daily budget of ${settings.maxTokensPerDay} tokens reached`,
        );
        return {
          ...base,
          status: 'skipped-budget',
          detail: `daily budget of ${settings.maxTokensPerDay} tokens reached`,
        };
      }
      const key = `${wt.projectId}:${entityId}`;
      this.inflight.get(key)?.abort(new Error('superseded by a newer request'));
      const ctrl = new AbortController();
      this.inflight.set(key, ctrl);
      const timeout = setTimeout(() => ctrl.abort(new Error('timed out')), 120_000);
      try {
        const r = await provider.enrich(
          bundle,
          existing,
          ENRICH_OUTPUT_SCHEMA_VERSION,
          { maxInputTokens: settings.maxInputTokensPerRequest, maxOutputTokens: estOut },
          ctrl.signal,
        );
        claims = r.claims;
        requestId = r.usage.requestId;
        ledger('completed', r.usage);
        this.db
          .prepare(
            'INSERT OR REPLACE INTO enrichment_cache (digest, provider, model, prompt_version, schema_version, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            digest,
            provider.id,
            provider.model,
            provider.promptTemplateVersion,
            ENRICH_OUTPUT_SCHEMA_VERSION,
            JSON.stringify({ claims }),
            new Date().toISOString(),
          );
        status = 'completed';
      } catch (e) {
        const cancelled = ctrl.signal.aborted;
        ledger(cancelled ? 'cancelled' : 'failed', undefined, String((e as Error).message ?? e));
        return {
          ...base,
          status: cancelled ? 'cancelled' : 'failed',
          detail: String((e as Error).message ?? e).slice(0, 300),
        };
      } finally {
        clearTimeout(timeout);
        if (this.inflight.get(key) === ctrl) this.inflight.delete(key);
      }
    }

    // only this subject, and nothing already stated by a model (carried forward or accepted earlier)
    const same = (c: ProposedClaim) =>
      existing.some(
        (e) =>
          e.origin === 'model' &&
          e.predicate === c.predicate &&
          JSON.stringify(e.value) === JSON.stringify(c.value),
      );
    const fresh = claims.filter((c) => c.subjectId === entityId && !same(c)).slice(0, 25);
    if (fresh.length === 0) return { ...base, status };
    const r = await proposeClaims(this.db, {
      snapshotId,
      origin: 'model',
      claims: fresh,
      modelMetadata: {
        provider: provider.id,
        model: provider.model,
        promptTemplateVersion: provider.promptTemplateVersion,
        inputDigest: digest,
        requestId,
      },
    });
    if (!r.ok)
      return {
        ...base,
        status: r.status === 409 ? 'stale-precondition' : 'failed',
        detail: r.error,
      };
    this.bus.publish({
      type: 'claims.proposed',
      data: {
        proposalId: r.proposalId,
        projectId: wt.projectId,
        worktreeId: wt.id,
        accepted: r.accepted.length,
        rejected: r.rejected.length,
      },
    });
    return { ...base, status, accepted: r.accepted.length, rejected: r.rejected };
  }
}
