import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stickerLabel } from '@auction-platform/shared';
import {
  buildConfirmUniverse,
  checkoutLotLabel,
  matchAlternateBarcode,
  matchCheckoutLot,
  planConfirmCodes,
  resolveCheckoutScan,
} from './checkout-lot-label';

describe('checkoutLotLabel', () => {
  it('sticker present → primary sticker, secondary BIN, noSticker false', () => {
    expect(
      checkoutLotLabel({
        lot_code: 'BIN-031005',
        sticker_code: 'BIN:TEA4840030',
      }),
    ).toEqual({
      primary: 'TEA4840030',
      secondary: 'BIN-031005',
      noSticker: false,
    });
  });

  it('operator-prefixed sticker "BIN:BRN4982227" → primary "BRN4982227"', () => {
    expect(
      checkoutLotLabel({
        lot_code: 'BIN-000100',
        sticker_code: 'BIN:BRN4982227',
      }),
    ).toEqual({
      primary: 'BRN4982227',
      secondary: 'BIN-000100',
      noSticker: false,
    });
  });

  it('no sticker → primary lot_code, noSticker true, secondary null', () => {
    expect(
      checkoutLotLabel({
        lot_code: 'BIN-031005',
        sticker_code: null,
      }),
    ).toEqual({
      primary: 'BIN-031005',
      secondary: null,
      noSticker: true,
    });
  });

  it('display_code equal to lot_code is treated as no sticker', () => {
    expect(
      checkoutLotLabel({
        lot_code: 'BIN-031005',
        sticker_code: null,
        display_code: 'BIN-031005',
      }),
    ).toEqual({
      primary: 'BIN-031005',
      secondary: null,
      noSticker: true,
    });
  });
});

describe('matchCheckoutLot', () => {
  it('a sticker on one line and a lot_code on another with the same text is ambiguous', () => {
    const lots = [
      { lot_code: 'TEA123', sticker_code: null, display_code: null },
      { lot_code: 'BIN-999', sticker_code: 'op:TEA123', display_code: null },
    ];
    expect(matchCheckoutLot(lots, 'TEA123')).toEqual({ kind: 'ambiguous', indices: [0, 1] });
  });

  it('falls back to lot_code', () => {
    const lots = [{ lot_code: 'BIN-031005', sticker_code: null }];
    expect(matchCheckoutLot(lots, 'BIN-031005')).toEqual({ kind: 'unique', index: 0 });
  });

  it('is case-insensitive and trims', () => {
    const lots = [{ lot_code: 'BIN-031005', sticker_code: 'BIN:tea4840030' }];
    expect(matchCheckoutLot(lots, '  TEA4840030  ')).toEqual({ kind: 'unique', index: 0 });
    expect(matchCheckoutLot(lots, 'bin-031005')).toEqual({ kind: 'unique', index: 0 });
  });

  it('empty → none; no match → none', () => {
    const lots = [{ lot_code: 'BIN-1', sticker_code: null }];
    expect(matchCheckoutLot(lots, '   ')).toEqual({ kind: 'none' });
    expect(matchCheckoutLot(lots, 'NOPE')).toEqual({ kind: 'none' });
  });

  it('matches display_code when it differs from lot_code', () => {
    const lots = [{ lot_code: 'BIN-007904', sticker_code: null, display_code: 'TEA4951993' }];
    expect(matchCheckoutLot(lots, 'TEA4951993')).toEqual({ kind: 'unique', index: 0 });
  });

  it('two case-distinct stickers are ambiguous in both orders', () => {
    const forward = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:tea123' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:TEA123' },
    ];
    const reverse = [...forward].reverse();
    expect(matchCheckoutLot(forward, 'TEA123')).toEqual({ kind: 'ambiguous', indices: [0, 1] });
    expect(matchCheckoutLot(reverse, 'tea123')).toEqual({ kind: 'ambiguous', indices: [0, 1] });
  });

  it('canonical/sticker collision is ambiguous in both orders', () => {
    const forward = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:TEA9000001' },
      { lot_id: 'b', lot_code: 'TEA9000001', sticker_code: null },
    ];
    const reverse = [...forward].reverse();
    expect(matchCheckoutLot(forward, 'TEA9000001')).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
    });
    expect(matchCheckoutLot(reverse, 'TEA9000001')).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
    });
  });

  it('two aliases of one lot stay a single unique match', () => {
    const lots = [{ lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:TEA123' }];
    expect(matchCheckoutLot(lots, 'TEA123')).toEqual({ kind: 'unique', index: 0 });
    expect(matchCheckoutLot(lots, 'BIN-1')).toEqual({ kind: 'unique', index: 0 });
  });

  it('the same lot listed on two combined orders is one match', () => {
    const lots = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:TEA123', invoice_id: 'inv-1' },
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:TEA123', invoice_id: 'inv-2' },
    ];
    expect(matchCheckoutLot(lots, 'TEA123')).toEqual({ kind: 'unique', index: 0 });
  });
});

describe('checkout scan wiring (#813)', () => {
  it('both scanner and typed entry refuse ambiguity before using an index', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../app/(staff)/checkout/pickup-verify.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /const scanMatch = resolveCheckoutScan\(lotStates, scan\.data, candidates\)/,
    );
    expect(src).toMatch(/scanMatch\.kind === 'ambiguous'/);
    expect(src).toMatch(/const scan = resolveCheckoutScan\(lotStates, code, \[code\]\)/);
    expect(src).toMatch(/scan\.kind === 'ambiguous'/);
    expect(src).not.toMatch(/idx = matchCheckoutLot\(/);
  });

  it('an ambiguous scan never checks a line off; unique scans check exactly one', () => {
    type State = {
      lot_id: string;
      lot_code: string;
      sticker_code: string | null;
      checked: boolean;
    };
    const initial: State[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:tea123', checked: false },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:TEA123', checked: false },
    ];
    const scanned = (states: State[], code: string): State[] => {
      const match = matchCheckoutLot(states, code);
      if (match.kind !== 'unique') return states;
      return states.map((s, i) => (i === match.index ? { ...s, checked: true } : s));
    };

    expect(scanned(initial, 'TEA123')).toEqual(initial);
    expect(scanned(initial, 'TEA123').filter((s) => s.checked)).toHaveLength(0);

    const oneChecked = scanned(initial, 'BIN-1');
    expect(oneChecked.filter((s) => s.checked).map((s) => s.lot_id)).toEqual(['a']);
    expect(oneChecked.filter((s) => !s.checked).map((s) => s.lot_code)).toEqual(['BIN-2']);

    // Repeated scans of either alias for the same lot stay deduplicated.
    const twice = scanned(scanned(initial, 'BIN-1'), 'tea123');
    expect(twice.filter((s) => s.checked).map((s) => s.lot_id)).toEqual(['a']);
  });

  it('the alternate-barcode path refuses before selecting a line (#816/#819)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../app/(staff)/checkout/pickup-verify.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /const scanMatch = resolveCheckoutScan\(lotStates, scan\.data, candidates\)/,
    );
    expect(src).not.toMatch(/const altMatch = matchAlternateBarcode\(lotStates, candidates\)/);
    expect(src).not.toMatch(/ls\.upc, ls\.lpn, ls\.tracking_number[\s\S]{0,120}findIndex/);
  });

  it('confirm builds per-invoice codes through planConfirmCodes (#816/#819)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../app/(staff)/checkout/pickup-verify.tsx'),
      'utf8',
    );
    expect(src).toMatch(/buildConfirmUniverse\(aliasUniverseRef\.current, lotStates\)/);
    expect(src).toMatch(/const plan = planConfirmCodes\(universe\)/);
    expect(src).toMatch(/if \(!plan\.ok\)/);
    expect(src).toMatch(/Object\.entries\(plan\.codesByInvoice\)/);
    expect(src).not.toMatch(/arr\.push\(ls\.lot_code as string\)/);
  });
});

// ── #816: alternate barcodes and submission codes ────────────────────────────

describe('matchAlternateBarcode (#816)', () => {
  type Alt = {
    lot_id: string;
    lot_code: string | null;
    sticker_code: string | null;
    upc?: string | null;
    lpn?: string | null;
    tracking_number?: string | null;
  };

  it('duplicate UPC is ambiguous in both row orders', () => {
    const forward: Alt[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, upc: '012345678901' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, upc: '012345678901' },
    ];
    const reverse = [...forward].reverse();
    expect(matchAlternateBarcode(forward, ['012345678901'])).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
    });
    expect(matchAlternateBarcode(reverse, ['012345678901'])).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
    });
  });

  it('duplicate LPN and tracking are ambiguous too', () => {
    const lots: Alt[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, lpn: 'LPN-77' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, tracking_number: '1Z999' },
      { lot_id: 'c', lot_code: 'BIN-3', sticker_code: null, lpn: 'LPN-77' },
      { lot_id: 'd', lot_code: 'BIN-4', sticker_code: null, tracking_number: '1Z999' },
    ];
    expect(matchAlternateBarcode(lots, ['LPN-77'])).toEqual({ kind: 'ambiguous', indices: [0, 2] });
    expect(matchAlternateBarcode(lots, ['1z999'])).toEqual({ kind: 'ambiguous', indices: [1, 3] });
  });

  it('a unique alternate match still succeeds, including a 12-digit suffix', () => {
    const lots: Alt[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, upc: '012345678901' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, tracking_number: '1Z999AA10123456784' },
    ];
    expect(matchAlternateBarcode(lots, ['012345678901'])).toEqual({ kind: 'unique', index: 0 });
    expect(matchAlternateBarcode(lots, ['x', '012345678901'])).toEqual({
      kind: 'unique',
      index: 0,
    });
    expect(matchAlternateBarcode(lots, ['1Z999AA10123456784'])).toEqual({
      kind: 'unique',
      index: 1,
    });
  });

  it('the same lot on two combined orders is one match; no match is none', () => {
    const lots: Alt[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, upc: 'U1' },
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, upc: 'U1' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, upc: 'U2' },
    ];
    expect(matchAlternateBarcode(lots, ['U1'])).toEqual({ kind: 'unique', index: 0 });
    expect(matchAlternateBarcode(lots, ['NOPE'])).toEqual({ kind: 'none' });
    expect(matchAlternateBarcode(lots, ['   '])).toEqual({ kind: 'none' });
  });
});

describe('planConfirmCodes (#816)', () => {
  type Line = {
    lot_id: string;
    lot_code: string | null;
    sticker_code: string | null;
    display_code?: string | null;
    upc?: string | null;
    lpn?: string | null;
    tracking_number?: string | null;
    invoice_id: string;
    checked: boolean;
  };

  // Mirrors 0487/0509: each supplied code resolves against lot_code or the raw
  // sticker half; 0509 throws when one code names more than one lot. A wrong
  // lot is a mis-stamp, which the old 0487 path would do silently.
  function serverStamp(lots: Line[], codes: string[]): string[] {
    const resolved = new Set<string>();
    for (const code of codes) {
      const needle = code.trim().toLowerCase();
      const ids = new Set(
        lots
          .filter((lot) => {
            const aliases = [
              lot.lot_code?.trim().toLowerCase(),
              stickerLabel(lot.sticker_code)?.toLowerCase(),
            ].filter((v): v is string => Boolean(v));
            return aliases.includes(needle);
          })
          .map((lot) => lot.lot_id),
      );
      if (ids.size > 1) throw new Error(`pickup_code_ambiguous: ${code}`);
      for (const id of ids) resolved.add(id);
    }
    return [...resolved];
  }

  const collisionPair = (order: 'forward' | 'reverse'): Line[] => {
    const lots: Line[] = [
      // A's canonical lot_code is B's printed sticker; A's own sticker is unique.
      {
        lot_id: 'a',
        lot_code: 'TEA9000001',
        sticker_code: 'BIN:AAA111',
        upc: '012345678901',
        invoice_id: 'inv-1',
        checked: true,
      },
      {
        lot_id: 'b',
        lot_code: 'BIN-2',
        sticker_code: 'BIN:TEA9000001',
        invoice_id: 'inv-1',
        checked: false,
      },
    ];
    return order === 'forward' ? lots : [...lots].reverse();
  };

  it('a unique raw alias is submitted by a code that resolves to that exact lot', () => {
    for (const order of ['forward', 'reverse'] as const) {
      const lots = collisionPair(order);
      const scanned = matchAlternateBarcode(lots, ['012345678901']);
      expect(scanned.kind).toBe('unique');
      if (scanned.kind !== 'unique') continue;

      const line = lots[scanned.index];
      expect(line?.lot_id).toBe('a');

      const plan = planConfirmCodes(
        lots.map((lot, i) => ({ ...lot, checked: i === scanned.index })),
      );
      expect(plan.ok).toBe(true);
      expect(plan.codesByInvoice['inv-1']).toEqual(['AAA111']);
      expect(serverStamp(lots, plan.codesByInvoice['inv-1']!)).toEqual(['a']);
    }
  });

  it('canonical codes are still used when they are unique', () => {
    const lots: Line[] = [
      {
        lot_id: 'a',
        lot_code: 'BIN-1',
        sticker_code: 'BIN:AAA111',
        invoice_id: 'inv-1',
        checked: true,
      },
      {
        lot_id: 'b',
        lot_code: 'BIN-2',
        sticker_code: 'BIN:BBB222',
        invoice_id: 'inv-1',
        checked: false,
      },
    ];
    const plan = planConfirmCodes(lots);
    expect(plan.ok).toBe(true);
    expect(plan.codesByInvoice['inv-1']).toEqual(['BIN-1']);
    expect(serverStamp(lots, plan.codesByInvoice['inv-1']!)).toEqual(['a']);
  });

  it('blocks the round when no alias is unique instead of stamping a sibling', () => {
    const lots: Line[] = [
      {
        lot_id: 'a',
        lot_code: 'TEA1',
        sticker_code: 'BIN:TEA2',
        invoice_id: 'inv-1',
        checked: true,
      },
      {
        lot_id: 'b',
        lot_code: 'TEA2',
        sticker_code: 'BIN:TEA1',
        invoice_id: 'inv-1',
        checked: false,
      },
    ];
    const plan = planConfirmCodes(lots);
    expect(plan.ok).toBe(false);
    expect(plan.blocked).toEqual([
      { invoice_id: 'inv-1', lot_code: 'TEA1', sticker_code: 'BIN:TEA2' },
    ]);
    expect(plan.codesByInvoice['inv-1']).toEqual([]);
  });

  it('partial consent sends only checked lines and leaves siblings owed', () => {
    const lots: Line[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, invoice_id: 'inv-1', checked: true },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, invoice_id: 'inv-1', checked: false },
      { lot_id: 'c', lot_code: 'BIN-3', sticker_code: null, invoice_id: 'inv-2', checked: true },
    ];
    const plan = planConfirmCodes(lots);
    expect(plan.ok).toBe(true);
    expect(plan.codesByInvoice).toEqual({ 'inv-1': ['BIN-1'], 'inv-2': ['BIN-3'] });
    expect(
      serverStamp(
        lots.filter((l) => l.invoice_id === 'inv-1'),
        plan.codesByInvoice['inv-1']!,
      ),
    ).toEqual(['a']);
  });

  it('repeated aliases for one checked lot emit one code', () => {
    const lots: Line[] = [
      {
        lot_id: 'a',
        lot_code: 'BIN-1',
        sticker_code: 'BIN:AAA111',
        upc: 'U1',
        invoice_id: 'inv-1',
        checked: true,
      },
    ];
    expect(planConfirmCodes(lots).codesByInvoice['inv-1']).toEqual(['BIN-1']);
  });

  it('combined orders are planned per invoice, so one invoice cannot block another', () => {
    const lots: Line[] = [
      {
        lot_id: 'a',
        lot_code: 'TEA1',
        sticker_code: 'BIN:TEA2',
        invoice_id: 'inv-1',
        checked: true,
      },
      {
        lot_id: 'b',
        lot_code: 'TEA2',
        sticker_code: 'BIN:TEA1',
        invoice_id: 'inv-1',
        checked: false,
      },
      { lot_id: 'c', lot_code: 'BIN-3', sticker_code: null, invoice_id: 'inv-2', checked: true },
    ];
    const plan = planConfirmCodes(lots);
    expect(plan.ok).toBe(false);
    expect(plan.codesByInvoice['inv-2']).toEqual(['BIN-3']);
  });
});

// ── #819: cross-namespace scans and the full invoice alias universe ──────────

describe('resolveCheckoutScan (#819)', () => {
  type ScanLot = {
    lot_id: string;
    lot_code: string | null;
    sticker_code: string | null;
    display_code?: string | null;
    upc?: string | null;
    lpn?: string | null;
    tracking_number?: string | null;
  };

  it('direct and alternate namespaces agree → unique', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:AAA111', upc: '012345678901' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:BBB222' },
    ];
    expect(resolveCheckoutScan(lots, 'AAA111', ['AAA111'])).toEqual({
      kind: 'unique',
      index: 0,
    });
  });

  it('an alternate-only match still succeeds', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:AAA111' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:BBB222', lpn: 'LPN-77' },
    ];
    expect(resolveCheckoutScan(lots, 'LPN-77', ['LPN-77'])).toEqual({
      kind: 'unique',
      index: 1,
    });
  });

  it('a direct sticker that also names a different box by alternate code is ambiguous', () => {
    const lots: ScanLot[] = [
      // A's printed sticker is literally "LPN-77"; B's Amazon LPN is "LPN-77".
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:LPN-77' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:BBB222', lpn: 'LPN-77' },
    ];
    expect(resolveCheckoutScan(lots, 'LPN-77', ['LPN-77'])).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
      reason: 'cross_namespace',
    });
  });

  it('direct ambiguity wins first', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:TEA123' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:TEA123' },
    ];
    expect(resolveCheckoutScan(lots, 'TEA123', ['TEA123'])).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
      reason: 'direct',
    });
  });

  it('alternate ambiguity is reported when the direct namespace misses', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, upc: 'U1' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: null, upc: 'U1' },
    ];
    expect(resolveCheckoutScan(lots, 'U1', ['U1'])).toEqual({
      kind: 'ambiguous',
      indices: [0, 1],
      reason: 'alternate',
    });
  });

  it('the same lot listed on two combined orders stays unique across namespaces', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:AAA111', upc: 'U1' },
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:AAA111', upc: 'U1' },
    ];
    expect(resolveCheckoutScan(lots, 'AAA111', ['U1'])).toEqual({ kind: 'unique', index: 0 });
  });

  it('no match in either namespace is none', () => {
    const lots: ScanLot[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: 'BIN:AAA111', upc: 'U1' },
    ];
    expect(resolveCheckoutScan(lots, 'NOPE', ['NOPE'])).toEqual({ kind: 'none' });
  });
});

describe('buildConfirmUniverse (#819)', () => {
  type Alias = {
    lot_id: string;
    lot_code: string | null;
    sticker_code: string | null;
    display_code: string | null;
    invoice_id: string;
  };

  it('includes hidden siblings for resolution but only marks owed/checked lines', () => {
    const alias: Alias[] = [
      // A's canonical code collides with hidden sibling B's sticker.
      { lot_id: 'a', lot_code: 'TEA1', sticker_code: 'BIN:AAA111', display_code: null, invoice_id: 'inv-1' },
      { lot_id: 'b', lot_code: 'BIN-2', sticker_code: 'BIN:TEA1', display_code: null, invoice_id: 'inv-1' },
      { lot_id: 'c', lot_code: 'BIN-3', sticker_code: null, display_code: null, invoice_id: 'inv-2' },
    ];
    const states = [
      { lot_id: 'a', invoice_id: 'inv-1', checked: true },
      { lot_id: 'c', invoice_id: 'inv-2', checked: true },
    ];

    const universe = buildConfirmUniverse(alias, states);
    expect(universe.map((u) => [u.lot_id, u.checked])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);

    const plan = planConfirmCodes(universe);
    expect(plan.ok).toBe(true);
    expect(plan.codesByInvoice).toEqual({ 'inv-1': ['AAA111'], 'inv-2': ['BIN-3'] });
  });

  it('matches states by invoice as well as lot, so a combined-order sibling is not checked', () => {
    const alias: Alias[] = [
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, display_code: null, invoice_id: 'inv-1' },
      { lot_id: 'a', lot_code: 'BIN-1', sticker_code: null, display_code: null, invoice_id: 'inv-2' },
    ];
    const states = [{ lot_id: 'a', invoice_id: 'inv-1', checked: true }];

    const universe = buildConfirmUniverse(alias, states);
    expect(universe.map((u) => [u.invoice_id, u.checked])).toEqual([
      ['inv-1', true],
      ['inv-2', false],
    ]);
  });
});

describe('checkoutLotLabel screen-shaped rows', () => {
  type LotVerifyRow = {
    lot_id: string;
    lot_code: string | null;
    sticker_code: string | null;
    display_code?: string | null;
  };

  it('maps three LotVerifyState-shaped rows to expected labels', () => {
    const rows: LotVerifyRow[] = [
      {
        lot_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        lot_code: 'BIN-001',
        sticker_code: 'BIN:PNK4858852',
      },
      {
        lot_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        lot_code: 'BIN-002',
        sticker_code: null,
      },
      {
        lot_id: 'cccccccc-dddd-eeee-ffff-000000000000',
        lot_code: 'BIN-003',
        sticker_code: null,
        display_code: 'GRA1111222',
      },
    ];

    expect(rows.map((r) => checkoutLotLabel(r))).toEqual([
      { primary: 'PNK4858852', secondary: 'BIN-001', noSticker: false },
      { primary: 'BIN-002', secondary: null, noSticker: true },
      { primary: 'GRA1111222', secondary: 'BIN-003', noSticker: false },
    ]);
  });
});
