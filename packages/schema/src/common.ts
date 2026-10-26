import { z } from 'zod';

/** Claim/relation status (plan §6). */
export const ClaimStatus = z.enum([
  'supported',
  'inferred',
  'unresolved',
  'conflicted',
  'stale',
  'rejected',
]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Where a claim came from (plan §6). */
export const ClaimOrigin = z.enum([
  'parser',
  'manifest',
  'framework-analyzer',
  'runtime',
  'human',
  'model',
]);
export type ClaimOrigin = z.infer<typeof ClaimOrigin>;

/**
 * Interpretable confidence labels, deliberately not probabilities.
 * - exact: read directly from syntax/manifest with no resolution step
 * - resolved: a resolution step (module resolution, symbol binding) succeeded
 * - observed: seen in captured runtime evidence
 * - heuristic: pattern match or naming convention; may be wrong
 * - proposed: model-proposed, pending validation
 * - asserted: a human explicitly asserted it
 */
export const ConfidenceCategory = z.enum([
  'exact',
  'resolved',
  'observed',
  'heuristic',
  'proposed',
  'asserted',
]);
export type ConfidenceCategory = z.infer<typeof ConfidenceCategory>;

export const RedactionState = z.enum(['none', 'redacted', 'withheld']);
export type RedactionState = z.infer<typeof RedactionState>;

export const Severity = z.enum(['info', 'warning', 'error']);

export const Diagnostic = z.object({
  severity: Severity,
  code: z.string().min(1),
  message: z.string(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;
