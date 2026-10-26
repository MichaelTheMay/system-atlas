import { describe, expect, it } from 'vitest';
import { isId } from '@atlas/schema';
import { stableId } from '../src/index.ts';

describe('stableId', () => {
  it('is deterministic and kind-prefixed', () => {
    const a = stableId('entity', 'proj_x', 'ts:module', 'src/a.ts');
    expect(a).toBe(stableId('entity', 'proj_x', 'ts:module', 'src/a.ts'));
    expect(isId('entity', a)).toBe(true);
  });
  it('separates parts unambiguously and scopes by project', () => {
    expect(stableId('entity', 'p', 'ab', 'c')).not.toBe(stableId('entity', 'p', 'a', 'bc'));
    expect(stableId('entity', 'p1', 'k')).not.toBe(stableId('entity', 'p2', 'k'));
  });
});
