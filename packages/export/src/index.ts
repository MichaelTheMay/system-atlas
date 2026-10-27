/** @atlas/export — JSON Canvas and Mermaid exports (plan §13). See docs/export.md. */
export * from './jsoncanvas.ts';
export * from './mermaid.ts';
export const SIDECAR_FORMAT = { format: 'atlas-export-sidecar', version: 1 } as const;
