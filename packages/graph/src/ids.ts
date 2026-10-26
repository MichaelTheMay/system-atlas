import { createHash } from 'node:crypto';
import { ID_PREFIXES, type IdKind } from '@atlas/schema';

/**
 * Deterministic IDs for records with natural identity (plan §9 identity precedence):
 * the same project + identity key always yields the same ID, so rescans cause no churn.
 * Keys are language-qualified semantic names, never line numbers.
 */
export function stableId(kind: IdKind, projectId: string, ...identityParts: string[]): string {
  const h = createHash('sha256');
  h.update(projectId);
  for (const part of identityParts) {
    h.update('\u0000');
    h.update(part);
  }
  return `${ID_PREFIXES[kind]}_${h.digest('hex').slice(0, 32)}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
