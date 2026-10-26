import {
  newId,
  type CoverageGap,
  type CoverageReport,
  type Diagnostic,
  type SupportLevel,
} from '@atlas/schema';
import { PROGRAMMING_LANGUAGES, type Inventory } from '@atlas/analyzers';

export interface AnalyzerRunRecord {
  id: string;
  version: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  filesAnalyzed: number;
  durationMs: number;
  diagnostics: Diagnostic[];
}

const LIST_LIMIT = 50;
const SUPPORT_ORDER: SupportLevel[] = ['skipped', 'inventory-only', 'syntax', 'deep'];

/** Coverage is computed from the exact input manifest plus what each analyzer reported (plan §6). */
export function buildCoverage(args: {
  snapshotId: string;
  manifestDigest: string;
  inventory: Inventory;
  support: Map<string, SupportLevel>;
  analyzers: AnalyzerRunRecord[];
  extraGaps: CoverageGap[];
}): CoverageReport {
  const { inventory, support } = args;
  const byLang = new Map<string, Map<SupportLevel, number>>();
  for (const f of inventory.files) {
    const s = support.get(f.path) ?? f.support;
    const m = byLang.get(f.language) ?? new Map();
    m.set(s, (m.get(s) ?? 0) + 1);
    byLang.set(f.language, m);
  }
  const byLanguage = [...byLang.entries()]
    .flatMap(([language, m]) =>
      [...m.entries()].map(([s, files]) => ({ language, support: s, files })),
    )
    .sort(
      (a, b) =>
        b.files - a.files ||
        a.language.localeCompare(b.language) ||
        SUPPORT_ORDER.indexOf(b.support) - SUPPORT_ORDER.indexOf(a.support),
    );

  const gaps: CoverageGap[] = [];
  for (const [language, m] of byLang) {
    const n = m.get('inventory-only') ?? 0;
    if (n > 0 && PROGRAMMING_LANGUAGES.has(language)) {
      gaps.push({
        kind: 'unsupported-language',
        detail: `${n} ${language} file(s) have no semantic analyzer; source browsing only`,
        count: n,
      });
    }
  }
  const reasons = [
    ['secret', 'skipped-secret', 'secret-like file not read'],
    ['binary', 'skipped-binary', 'binary file not analyzed'],
    ['size', 'skipped-size', 'file larger than the analysis size limit'],
    [
      'symlink-escape',
      'skipped-symlink-escape',
      'symlink resolves outside the registered root; not followed',
    ],
    [
      'nested-repository',
      'nested-repository',
      'nested repository or submodule; register it separately to analyze it',
    ],
    ['unreadable', 'unreadable', 'file could not be read'],
  ] as const;
  for (const [reason, kind, detail] of reasons) {
    const entries = inventory.skipped.filter((s) => s.reason === reason);
    if (entries.length === 0) continue;
    if (reason === 'binary' || entries.length > LIST_LIMIT) {
      gaps.push({ kind, detail: `${entries.length} file(s): ${detail}`, count: entries.length });
    } else {
      for (const e of entries) gaps.push({ kind, path: e.path, detail });
    }
  }
  for (const a of args.analyzers) {
    if (a.status === 'failed') {
      const timeout = a.diagnostics.some((d) => d.code === 'analyzer-timeout');
      gaps.push({
        kind: timeout ? 'analyzer-timeout' : 'analyzer-failed',
        analyzerId: a.id,
        detail: a.diagnostics[0]?.message ?? 'analyzer failed',
      });
    }
  }
  gaps.push(...args.extraGaps);

  return {
    schemaVersion: 1,
    id: newId('coverage'),
    snapshotId: args.snapshotId,
    manifestDigest: args.manifestDigest,
    totals: {
      files: inventory.files.length,
      bytes: inventory.files.reduce((n, f) => n + f.size, 0),
    },
    byLanguage,
    analyzers: args.analyzers.map((a) => ({ ...a, diagnostics: a.diagnostics.slice(0, 100) })),
    gaps,
  };
}
