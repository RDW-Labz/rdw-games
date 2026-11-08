// Owner 2026-10-23: carry-over goes 5 lots per request with progress, so no
// request runs long (a 27-lot batch ran 11 s the day of the Error Code 520).
import { describe, it, expect } from 'vitest';
import { CARRYOVER_CHUNK, chunkIds, emptyReport, mergeReports, notTried, summarize } from '../carryover-batches';

describe('chunkIds', () => {
  it('splits into chunks of 5 by default, keeping order', () => {
    expect(CARRYOVER_CHUNK).toBe(5);
    const ids = Array.from({ length: 27 }, (_, i) => `l${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 5, 5, 5, 2]);
    expect(chunks.flat()).toEqual(ids);
  });
  it('handles empty, exact and odd sizes', () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c', 'd', 'e']]);
    expect(chunkIds(['a', 'b', 'c'], 0)).toEqual([['a'], ['b'], ['c']]);
  });
});

describe('mergeReports', () => {
  it('concatenates every group in order', () => {
    const a = { carried: [{ lotId: '1', code: 'A', newCode: 'N1' }], failed: [], already: [] };
    const b = {
      carried: [{ lotId: '2', code: 'B', newCode: 'N2' }],
      failed: [{ lotId: '3', code: 'C', reason: 'x' }],
      already: [{ lotId: '4', code: 'D', newCode: null }],
    };
    expect(mergeReports(a, b)).toEqual({
      carried: [a.carried[0], b.carried[0]],
      failed: b.failed,
      already: b.already,
    });
    expect(mergeReports(emptyReport(), emptyReport())).toEqual(emptyReport());
  });
});

describe('notTried', () => {
  it('marks lots never sent, with the code staff read', () => {
    expect(notTried(['x'], 'Auction not found.', () => 'TEA1')).toEqual([
      { lotId: 'x', code: 'TEA1', reason: 'Not tried: Auction not found.' },
    ]);
  });
});

describe('summarize', () => {
  const c = (n: number) => Array.from({ length: n }, (_, i) => ({ lotId: `c${i}`, code: `C${i}`, newCode: `N${i}` }));
  const f = (n: number) => Array.from({ length: n }, (_, i) => ({ lotId: `f${i}`, code: `F${i}`, reason: 'r' }));
  const a = (n: number) => Array.from({ length: n }, (_, i) => ({ lotId: `a${i}`, code: `A${i}`, newCode: null }));
  it('all carried → ok', () => {
    expect(summarize({ carried: c(26), failed: [], already: [] }, 26)).toEqual({ ok: true, message: null });
  });
  it('some failed', () => {
    expect(summarize({ carried: c(20), failed: f(6), already: [] }, 26).message).toBe(
      'Carried over 20 of 26. 6 not added — see the list below.',
    );
    expect(summarize({ carried: [], failed: f(3), already: [] }, 3).message).toBe(
      'Nothing was carried over. 3 not added — see the list below.',
    );
  });
  it('some already carried over earlier is not a failure', () => {
    expect(summarize({ carried: c(1), failed: [], already: a(25) }, 26).message).toBe(
      'Carried over 1 of 26. 25 were already carried over earlier — see the list below.',
    );
    expect(summarize({ carried: [], failed: [], already: a(1) }, 1).message).toBe(
      'Nothing new to add: 1 was already carried over earlier — see the list below.',
    );
  });
});
