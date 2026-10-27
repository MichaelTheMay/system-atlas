/**
 * Model provider contract (plan §12): `enrich(evidenceBundle, existingClaims, outputSchema, budget,
 * abortSignal)`. Atlas ships no network provider: the only implementation is the deterministic mock
 * used by CI and demos. Direct API providers are added separately and only with the user's consent,
 * because they send repository excerpts to a third party and cost money.
 */
export interface BundleExcerpt {
  evidenceId: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Redacted before it ever reaches a provider. */
  text: string;
}

export interface EvidenceBundle {
  snapshotId: string;
  subject: { id: string; kind: string; displayName: string; canonicalName: string; path?: string };
  owners: string[];
  relations: { direction: 'in' | 'out'; kind: string; other: string; status: string }[];
  excerpts: BundleExcerpt[];
}

export interface ExistingClaim {
  predicate: string;
  value: unknown;
  origin: string;
  status: string;
}

export interface ProposedClaim {
  subjectId: string;
  predicate: string;
  value: unknown;
  citations: (
    { evidenceId: string } | { path: string; startLine: number; endLine: number; quote?: string }
  )[];
  rationale?: string;
}

export interface EnrichBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface EnrichResult {
  claims: ProposedClaim[];
  /** What the provider reported; absent fields stay unknown (never estimated here). */
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; requestId?: string };
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly promptTemplateVersion: string;
  enrich(
    bundle: EvidenceBundle,
    existingClaims: ExistingClaim[],
    outputSchemaVersion: string,
    budget: EnrichBudget,
    signal: AbortSignal,
  ): Promise<EnrichResult>;
}

/** Version of the claim output schema (predicates + citation shape) providers must produce. */
export const ENRICH_OUTPUT_SCHEMA_VERSION = 'claims-v1';

/**
 * Deterministic test/demo provider. `mode: 'adversarial'` additionally emits claims with invented
 * citations, to prove enrichment output goes through the same validator as everything else.
 * `delayMs` lets tests exercise cancellation. Every bundle it receives is kept in `seen`.
 */
export function createMockProvider(
  opts: { mode?: 'honest' | 'adversarial'; delayMs?: number } = {},
) {
  const seen: EvidenceBundle[] = [];
  const provider: ModelProvider & { seen: EvidenceBundle[]; calls: () => number } = {
    id: 'mock',
    model: `mock-${opts.mode ?? 'honest'}`,
    promptTemplateVersion: 'mock-1',
    seen,
    calls: () => seen.length,
    async enrich(bundle, existing, _schema, _budget, signal) {
      seen.push(structuredClone(bundle));
      if (opts.delayMs)
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      signal.throwIfAborted();
      const first = bundle.excerpts[0];
      const claims: ProposedClaim[] = [];
      const path = bundle.subject.path ?? '';
      const role = /(^|\/)(test|tests|__tests__)\/|\.test\./.test(path)
        ? 'test'
        : /db|store|repo|sql/i.test(path)
          ? 'storage'
          : /route|server|api|handler/i.test(path)
            ? 'api'
            : /worker|job|queue/i.test(path)
              ? 'worker'
              : 'library';
      const has = (p: string) =>
        existing.some((c) => c.predicate === p && c.origin === 'model' && c.status !== 'rejected');
      if (first && !has('role'))
        claims.push({
          subjectId: bundle.subject.id,
          predicate: 'role',
          value: role,
          citations: [{ evidenceId: first.evidenceId }],
          rationale: 'mock heuristic on the path',
        });
      if (first && !has('summary')) {
        const out = bundle.relations.filter((r) => r.direction === 'out').length;
        claims.push({
          subjectId: bundle.subject.id,
          predicate: 'summary',
          value: `${bundle.subject.displayName} (${bundle.subject.kind}) with ${out} outgoing relation(s).`,
          citations: [{ path: first.path, startLine: first.startLine, endLine: first.endLine }],
        });
      }
      if (opts.mode === 'adversarial') {
        claims.push({
          subjectId: bundle.subject.id,
          predicate: 'concern',
          value: 'Invented evidence id.',
          citations: [{ evidenceId: `evd_${'0'.repeat(32)}` }],
        });
        claims.push({
          subjectId: bundle.subject.id,
          predicate: 'concern',
          value: 'Invented file.',
          citations: [{ path: 'src/does-not-exist.ts', startLine: 1, endLine: 3 }],
        });
      }
      const inputChars = JSON.stringify(bundle).length;
      return {
        claims,
        usage: {
          inputTokens: Math.ceil(inputChars / 4),
          outputTokens: 40 * claims.length,
          costUsd: 0,
        },
      };
    },
  };
  return provider;
}
