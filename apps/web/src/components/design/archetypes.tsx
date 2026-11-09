/** Shared vocabulary of the system-design lens (D01): archetype icons/labels and provenance wording. */

export type Provenance = 'detected' | 'proposed' | 'accepted';

export const ARCHETYPE_ICON: Record<string, string> = {
  client: '▭',
  'api-service': '⇄',
  worker: '⚙',
  queue: '≋',
  datastore: '⛁',
  cache: '◍',
  'external-api': '⬚',
  library: '⊕',
  service: '⬡',
};

const ARCHETYPE_LABEL: Record<string, string> = {
  client: 'client',
  'api-service': 'API service',
  worker: 'worker',
  queue: 'queue',
  datastore: 'datastore',
  cache: 'cache',
  'external-api': 'external API',
  library: 'library',
  service: 'service',
};

export const archetypeLabel = (a: string) => ARCHETYPE_LABEL[a] ?? a;

/** Badge text: proposals are hypotheses, so they say so. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  detected: 'detected',
  proposed: 'proposed (inferred)',
  accepted: 'accepted',
};

/** One sentence per provenance, shown in the Inspector next to the badge. */
export const PROVENANCE_TEXT: Record<Provenance, string> = {
  detected:
    'Detected: derived deterministically from analyzer facts (deployables, packages, endpoints, stores and queues). No model was involved.',
  proposed:
    'Proposed: grouped by an agent or model through cited subsystem claims. It is a hypothesis, not a fact, until a person promotes it, and it turns stale when its evidence changes.',
  accepted:
    'Accepted: a person grouped these boxes or promoted a proposal. The grouping is a human claim that still cites evidence.',
};

export const isDesignLens = (lens: string | undefined) =>
  lens === 'design-system' || lens === 'design-subsystem';

export function ProvenanceBadge({ provenance }: { provenance?: Provenance }) {
  if (!provenance) return null;
  return (
    <span className={`prov prov-${provenance}`} title={PROVENANCE_TEXT[provenance]}>
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}
