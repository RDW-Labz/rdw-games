import { describe, expect, it } from 'vitest';
import { relistsAgoLabel } from '../relist-ago-label';

describe('relistsAgoLabel', () => {
  it('counts up from the direct parent (BIN-038440 <- BIN-034795 <- BIN-031301)', () => {
    const lineage = ['BIN-034795', 'BIN-031301'];
    expect(lineage.map((code, i) => `${code}: ${relistsAgoLabel(i)}`)).toEqual([
      'BIN-034795: 1 relist ago',
      'BIN-031301: 2 relists ago',
    ]);
  });
  it('does not depend on how long the chain is', () => {
    expect(relistsAgoLabel(0)).toBe('1 relist ago');
    expect(relistsAgoLabel(4)).toBe('5 relists ago');
  });
});
