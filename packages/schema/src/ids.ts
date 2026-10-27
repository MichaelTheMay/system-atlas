import { z } from 'zod';

/**
 * Opaque, prefixed identifiers. Random IDs use a UUIDv7 body (time-ordered);
 * stable IDs (entities, relations, views) use a content-derived hex body and are
 * produced by @atlas/graph. Consumers must treat the body as opaque.
 */
export const ID_PREFIXES = {
  project: 'proj',
  worktree: 'wt',
  snapshot: 'snap',
  coverage: 'cov',
  entity: 'ent',
  relation: 'rel',
  evidence: 'evd',
  claim: 'clm',
  canvas: 'cvs',
  overlay: 'ovl',
  annotation: 'ann',
  run: 'run',
  event: 'evt',
  artifact: 'art',
  correlation: 'cor',
  assertion: 'asr',
  issue: 'iss',
  proposal: 'prp',
  usage: 'use',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ID_BODY = '[0-9a-f]{16,64}';

export function idSchema<K extends IdKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z.string().regex(new RegExp(`^${prefix}_${ID_BODY}$`), `expected a ${prefix}_ identifier`);
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${ID_PREFIXES[kind]}_${ID_BODY}$`).test(value);
}

/** UUIDv7 as 32 lowercase hex chars: 48-bit unix ms timestamp, version, variant, random. */
export function uuidv7Hex(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** New random, time-ordered ID for records that have no natural identity (runs, events, snapshots). */
export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${uuidv7Hex(now)}`;
}

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
export const Timestamp = z.iso.datetime({ offset: true });
export const RepoRelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'must be repository-relative')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ..');

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);
export const JsonObject = z.record(z.string(), JsonValue);
