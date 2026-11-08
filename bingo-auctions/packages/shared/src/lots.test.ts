// Pins the scanned-code ranking against the shape that produced the
// 2026-07-30 field report (lot PNK4858852).
//
// A relist hands the physical identity down: `relist_lot_into_auction` (migs
// 0192/0213) mints a child, moves the sticker onto it, and leaves the parent as
// a tombstone. So one printed label answers to BOTH the retired parent's
// `lot_code` and the raw half of the live child's `sticker_code`. 855 lot pairs
// on prod are in that shape — 142 with a live child, 408 with a won one.
//
// `rankScannedLots` has to agree with mig 0304's `_find_lot_by_scan`, because
// the storefront ranks in TypeScript and the scanners rank in SQL. If they
// drift, one screen calls a box sold and the next calls it canceled — which is
// exactly what the field report described.

import { describe, expect, it } from 'vitest';
import {
  lotCodeMatchFilters,
  lotDisplayCode,
  preferActiveLot,
  rankScannedLots,
  stickerLabel,
} from './lots';

const ancestor = {
  id: 'a',
  lot_code: 'PNK4858852',
  sticker_code: null,
  status: 'relisted',
  created_at: '2026-06-01T00:00:00Z',
};
const child = {
  id: 'b',
  lot_code: 'BIN-001737',
  sticker_code: 'BIN:PNK4858852',
  status: 'live',
  created_at: '2026-07-20T00:00:00Z',
};

describe('rankScannedLots', () => {
  it('prefers the live child over the retired ancestor', () => {
    expect(rankScannedLots([ancestor, child], 'PNK4858852')?.id).toBe('b');
    // Input order must not matter.
    expect(rankScannedLots([child, ancestor], 'PNK4858852')?.id).toBe('b');
  });

  it('prefers the sticker holder when BOTH sides are active', () => {
    // 142 prod pairs have a live child, and 7 have a non-retired ancestor too —
    // status alone cannot break those ties, so the tiebreak is which column
    // matched. The sticker is what is physically on the box.
    const wonAncestor = { ...ancestor, status: 'won' };
    expect(rankScannedLots([wonAncestor, child], 'PNK4858852')?.id).toBe('b');
    // preferActiveLot has no notion of which field matched, so it can only fall
    // through to created_at here — the reason rankScannedLots exists.
    expect(preferActiveLot([wonAncestor, child])?.id).toBe('b');
  });

  it('still answers with the ancestor when the child is the dead one', () => {
    const deadChild = { ...child, status: 'canceled' };
    const liveAncestor = { ...ancestor, status: 'in_inventory' };
    expect(rankScannedLots([liveAncestor, deadChild], 'PNK4858852')?.id).toBe('a');
  });

  it('matches the sticker label case-insensitively and with the operator prefix', () => {
    expect(rankScannedLots([ancestor, child], 'pnk4858852')?.id).toBe('b');
    expect(rankScannedLots([ancestor, child], 'BIN:PNK4858852')?.id).toBe('b');
  });

  it('falls back to newest when nothing else separates two rows', () => {
    const older = { ...child, id: 'c', created_at: '2026-01-01T00:00:00Z' };
    expect(rankScannedLots([older, child], 'PNK4858852')?.id).toBe('b');
  });

  it('returns null for an empty list', () => {
    expect(rankScannedLots([], 'PNK4858852')).toBeNull();
  });
});

describe('lotCodeMatchFilters', () => {
  it('probes every column a printed label can live in', () => {
    const f = lotCodeMatchFilters('PNK4858852')!;
    expect(f).toContain('lot_code.eq.PNK4858852');
    expect(f).toContain('sticker_code.eq.PNK4858852');
    expect(f).toContain('legacy_lot_code.eq.PNK4858852');
    // sticker_code is stored `{op}:{RAW}`; sticker_raw_upper (0362) is that
    // RAW half, upper-cased, so the suffix match is an indexed equality.
    expect(f).toContain('sticker_raw_upper.eq.PNK4858852');
  });

  it('matches a lower-case label without a pattern', () => {
    const f = lotCodeMatchFilters('pnk4858852')!;
    expect(f).toContain('lot_code.eq.pnk4858852'); // as typed
    expect(f).toContain('lot_code.eq.PNK4858852'); // case-folded
    expect(f).toContain('legacy_lot_code.eq.PNK4858852');
    expect(f).toContain('sticker_raw_upper.eq.PNK4858852');
  });

  it('emits no LIKE pattern at all — every term must be indexable (0362)', () => {
    // A single unindexable OR branch makes Postgres scan all of `lots`, which
    // is what took the site down on 2026-09-19. Guard the whole shape, not
    // just one input.
    for (const code of ['PNK4858852', 'pnk4858852', 'PNK_01', 'BIN-001737', 'a']) {
      const f = lotCodeMatchFilters(code)!;
      expect(f.every((t) => !t.includes('ilike') && !t.includes('like'))).toBe(true);
      expect(f.every((t) => !t.includes('%'))).toBe(true);
    }
  });

  it('still probes a code containing an underscore, case-insensitively', () => {
    // Previously `_` disabled the pattern terms entirely, because it is a
    // single-char LIKE wildcard and PostgREST offers no ESCAPE. Equality has
    // no wildcard semantics, so the guard is gone and these codes now get the
    // same case-insensitive treatment as every other code.
    const f = lotCodeMatchFilters('pnk_01')!;
    expect(f).toContain('lot_code.eq.pnk_01');
    expect(f).toContain('lot_code.eq.PNK_01');
    expect(f).toContain('sticker_raw_upper.eq.PNK_01');
  });

  it('does not emit redundant terms for an already-upper-case code', () => {
    const f = lotCodeMatchFilters('PNK4858852')!;
    expect(new Set(f).size).toBe(f.length);
    expect(f.filter((t) => t === 'lot_code.eq.PNK4858852')).toHaveLength(1);
  });

  it('refuses codes that could break out of the or() grammar', () => {
    for (const bad of ['PNK,4858852', 'a.b', 'x)y', '%', '', '   ', '*']) {
      expect(lotCodeMatchFilters(bad)).toBeNull();
    }
  });
});

describe('stickerLabel', () => {
  it('strips the operator prefix', () => {
    expect(stickerLabel('BIN:PNK4858852')).toBe('PNK4858852');
  });

  it('passes through a malformed value rather than dropping it', () => {
    expect(stickerLabel('PNK4858852')).toBe('PNK4858852');
    expect(stickerLabel(null)).toBeNull();
  });
});

// The 2026-08-07 pickup-pass report: won lot BIN-007904 showed a BIN-######
// that appears nowhere on the box. It is a relist child of legacy lot
// TEA4951993, and its sticker is held by a superseded sibling (BIN-006802),
// so it can never own `BIN:TEA4951993` itself — the unique index allows one
// holder per label. Display has to read through the lineage instead.
describe('lotDisplayCode', () => {
  it('prefers the lot own sticker over everything else', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-006802',
        sticker_code: 'BIN:TEA4951993',
        relisted_from: { lot_code: 'GRA1111111' },
      }),
    ).toBe('TEA4951993');
  });

  it('falls back to lot_code when there is no lineage', () => {
    expect(lotDisplayCode({ lot_code: 'BIN-007904', sticker_code: null })).toBe('BIN-007904');
  });

  // mig 0315: the database resolves the same rule as a computed column, over
  // the FULL lineage and with no embed. The TS walk can only see the ancestors
  // the caller happened to join — two, in every shipped select — so when the
  // server has answered, that answer wins.
  it('prefers the server-resolved display_code over any local guess', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-007904',
        sticker_code: null,
        display_code: 'TEA4951993',
      }),
    ).toBe('TEA4951993');
  });

  it('uses display_code where an un-embedded lineage would have shown BIN-######', () => {
    // Exactly the shipped bug: no sticker, no `relisted_from` in the select.
    expect(
      lotDisplayCode({ lot_code: 'BIN-007904', sticker_code: null, display_code: 'TEA4951993' }),
    ).not.toBe('BIN-007904');
  });

  it('resolves a chain deeper than the two ancestors any select embeds', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-009500',
        sticker_code: null,
        display_code: 'TEA4951993',
        // Third ancestor: beyond what `relisted_from(relisted_from(…))` returns,
        // so without display_code this would answer BIN-009500.
        relisted_from: {
          lot_code: 'BIN-009000',
          sticker_code: null,
          relisted_from: { lot_code: 'BIN-007904', sticker_code: null },
        },
      }),
    ).toBe('TEA4951993');
  });

  it('ignores an empty display_code rather than blanking the label', () => {
    expect(
      lotDisplayCode({ lot_code: 'BIN-007904', sticker_code: 'BIN:PNK4858852', display_code: '  ' }),
    ).toBe('PNK4858852');
  });

  it('reads the box label off the legacy parent when the child has no sticker', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-007904',
        sticker_code: null,
        relisted_from: { lot_code: 'TEA4951993', sticker_code: null },
      }),
    ).toBe('TEA4951993');
  });

  it('walks a twice-relisted chain to reach the label', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-009000',
        sticker_code: null,
        relisted_from: {
          lot_code: 'BIN-007904',
          sticker_code: null,
          relisted_from: { lot_code: 'TEA4951993', sticker_code: null },
        },
      }),
    ).toBe('TEA4951993');
  });

  it('prefers an ancestor sticker over that ancestor synthetic lot_code', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-009000',
        sticker_code: null,
        relisted_from: { lot_code: 'BIN-007904', sticker_code: 'BIN:PNK4858852' },
      }),
    ).toBe('PNK4858852');
  });

  it('ignores a synthetic BIN-###### ancestor and keeps its own code', () => {
    expect(
      lotDisplayCode({
        lot_code: 'BIN-009000',
        sticker_code: null,
        relisted_from: { lot_code: 'BIN-007904', sticker_code: null },
      }),
    ).toBe('BIN-009000');
  });

  it('does not loop forever on a cyclic lineage', () => {
    const a: Parameters<typeof lotDisplayCode>[0] = { lot_code: 'BIN-1', sticker_code: null };
    const b = { lot_code: 'BIN-2', sticker_code: null, relisted_from: a };
    a.relisted_from = b;
    expect(lotDisplayCode(a)).toBe('BIN-1');
  });
});
