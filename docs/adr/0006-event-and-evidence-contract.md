# ADR-0006: Versioned Zod contracts; Atlas-owned event contract

Status: accepted (2026-10-26)

## Decision

- Every persisted record carries `schemaVersion` and is validated with Zod 4 schemas in `@atlas/schema` (plan §6).
- IDs are opaque and prefixed (`ent_`, `run_`...). Random IDs use UUIDv7 bodies (time-ordered); natural-identity records (entities, relations, views) use deterministic SHA-256-derived bodies from `@atlas/graph#stableId`, keyed by language-qualified names, never line numbers.
- Invariants are enforced in the schemas: supported relations/claims need evidence; model-proposed relations cannot be supported; model claims need model metadata; file evidence needs path + content hash + snapshot; heuristic correlations cannot be supported.
- Events are append-only and deduplicated on `(producerId, producerEventId)`. Process outcome (run status/exit code) is separate from task outcome (assertions).
- Browser evidence comes from Atlas's own Playwright wrapper events and screenshots (E03). Playwright traces are linked for the Trace Viewer but their internal ZIP format is not part of the contract.
