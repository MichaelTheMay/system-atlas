import { describe, expect, it } from 'vitest';
import {
  Claim,
  Correlation,
  Evidence,
  Relation,
  Snapshot,
  ViewQuery,
  idSchema,
  isId,
  newId,
  uuidv7Hex,
  RepoRelativePath,
} from '../src/index.ts';
import { resolveAtlasPaths } from '../src/node/index.ts';

const sha = 'a'.repeat(64);
const now = '2026-10-26T12:00:00.000Z';

describe('ids', () => {
  it('produces time-ordered prefixed uuidv7 ids', () => {
    const a = newId('run', 1_000);
    const b = newId('run', 2_000);
    expect(isId('run', a)).toBe(true);
    expect(a < b).toBe(true);
    expect(uuidv7Hex()[12]).toBe('7');
  });
  it('rejects ids with the wrong prefix', () => {
    expect(idSchema('entity').safeParse(newId('run')).success).toBe(false);
  });
});

describe('paths', () => {
  it('rejects absolute and parent-traversal paths', () => {
    expect(RepoRelativePath.safeParse('src/a.ts').success).toBe(true);
    expect(RepoRelativePath.safeParse('/etc/passwd').success).toBe(false);
    expect(RepoRelativePath.safeParse('src/../../x').success).toBe(false);
  });
  it('resolves data dirs outside any repository', () => {
    const p = resolveAtlasPaths({ HOME: '/home/u' }, 'linux');
    expect(p.dataDir).toBe('/home/u/.local/share/system-atlas');
    expect(p.discoveryFile).toBe('/home/u/.local/share/system-atlas/run/daemon.json');
    expect(
      resolveAtlasPaths({ HOME: '/h', XDG_RUNTIME_DIR: '/run/user/1' }, 'linux').discoveryFile,
    ).toBe('/run/user/1/system-atlas/daemon.json');
  });
});

describe('semantic contracts', () => {
  const base = {
    schemaVersion: 1 as const,
    id: newId('relation'),
    fromId: newId('entity'),
    toId: newId('entity'),
    kind: 'imports' as const,
    qualifiers: {},
    snapshotId: newId('snapshot'),
  };
  it('supported relations require evidence', () => {
    expect(
      Relation.safeParse({
        ...base,
        evidenceIds: [],
        status: 'supported',
        confidenceCategory: 'exact',
      }).success,
    ).toBe(false);
    expect(
      Relation.safeParse({
        ...base,
        evidenceIds: [newId('evidence')],
        status: 'supported',
        confidenceCategory: 'exact',
      }).success,
    ).toBe(true);
  });
  it('model-proposed relations cannot be supported', () => {
    expect(
      Relation.safeParse({
        ...base,
        evidenceIds: [newId('evidence')],
        status: 'supported',
        confidenceCategory: 'proposed',
      }).success,
    ).toBe(false);
    expect(
      Relation.safeParse({
        ...base,
        evidenceIds: [],
        status: 'inferred',
        confidenceCategory: 'proposed',
      }).success,
    ).toBe(true);
  });
  it('model claims require metadata', () => {
    const claim = {
      schemaVersion: 1,
      id: newId('claim'),
      subjectId: newId('entity'),
      predicate: 'responsibility',
      value: 'Handles billing',
      origin: 'model',
      evidenceIds: [],
      status: 'inferred',
      snapshotId: newId('snapshot'),
    };
    expect(Claim.safeParse(claim).success).toBe(false);
    expect(
      Claim.safeParse({
        ...claim,
        modelMetadata: { provider: 'mock', model: 'mock-1', promptTemplateVersion: 'v1' },
      }).success,
    ).toBe(true);
  });
  it('file evidence requires path, hash and snapshot', () => {
    const ev = {
      schemaVersion: 1,
      id: newId('evidence'),
      sourceKind: 'source-file',
      extractorId: 'ts',
      extractorVersion: '1',
      capturedAt: now,
      redactionState: 'none',
    };
    expect(Evidence.safeParse(ev).success).toBe(false);
    expect(
      Evidence.safeParse({
        ...ev,
        repoRelativePath: 'src/a.ts',
        contentHash: sha,
        snapshotId: newId('snapshot'),
        startLine: 3,
        endLine: 4,
      }).success,
    ).toBe(true);
    expect(
      Evidence.safeParse({
        ...ev,
        repoRelativePath: 'src/a.ts',
        contentHash: sha,
        snapshotId: newId('snapshot'),
        startLine: 5,
        endLine: 4,
      }).success,
    ).toBe(false);
  });
});

describe('snapshot', () => {
  it('validates a dirty snapshot without HEAD', () => {
    const s = {
      schemaVersion: 1,
      id: newId('snapshot'),
      projectId: newId('project'),
      worktreeId: newId('worktree'),
      dirtyTreeDigest: sha,
      dirty: true,
      createdAt: now,
      analyzerVersions: { generic: '0.1.0' },
      configDigest: sha,
      state: 'building',
    };
    expect(Snapshot.parse(s).state).toBe('building');
  });
});

describe('view query', () => {
  it('accepts nested structured selectors and bounds limits', () => {
    const q = {
      select: {
        type: 'union',
        selectors: [
          { type: 'children-of', entityId: newId('entity') },
          { type: 'kinds', kinds: ['endpoint'] },
        ],
      },
      limit: 100,
    };
    expect(ViewQuery.safeParse(q).success).toBe(true);
    expect(ViewQuery.safeParse({ ...q, limit: 100_000 }).success).toBe(false);
    expect(
      ViewQuery.safeParse({ select: { type: 'sql', text: 'select 1' }, limit: 1 }).success,
    ).toBe(false);
  });
});

describe('execution contracts', () => {
  it('heuristic correlations cannot be supported', () => {
    const c = {
      schemaVersion: 1,
      id: newId('correlation'),
      eventOrArtifactId: newId('artifact'),
      entityId: newId('entity'),
      method: 'heuristic-proximity',
      evidenceIds: [],
      status: 'supported',
    };
    expect(Correlation.safeParse(c).success).toBe(false);
    expect(Correlation.safeParse({ ...c, status: 'inferred' }).success).toBe(true);
  });
});
