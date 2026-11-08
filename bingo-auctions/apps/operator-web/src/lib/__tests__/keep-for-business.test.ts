import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  csvCell,
  dollarsToCents,
  hasAtMostTwoDecimals,
  KEEP_REFUSALS,
  KEPT_CSV_HEADER,
  keepRefusalMessage,
  keptCsvLine,
  summarizeKeeps,
  type KeptRow,
} from '../keep-for-business';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/db/migrations/0381_keep_for_business.sql',
);

describe('dollarsToCents', () => {
  it('rounds float noise instead of truncating', () => {
    expect(dollarsToCents(19.99)).toBe(1999);
    expect(dollarsToCents(0.29)).toBe(29);
    expect(dollarsToCents(1.005)).toBe(100); // 100.49999… — float, not a bug here
  });
  it('allows zero and whole dollars', () => {
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(12)).toBe(1200);
    expect(dollarsToCents(1_000_000)).toBe(100_000_000);
  });
});

describe('hasAtMostTwoDecimals', () => {
  it('accepts 0-2 decimals and rejects more', () => {
    expect(hasAtMostTwoDecimals(0)).toBe(true);
    expect(hasAtMostTwoDecimals(5.5)).toBe(true);
    expect(hasAtMostTwoDecimals(19.99)).toBe(true);
    expect(hasAtMostTwoDecimals(19.999)).toBe(false);
    expect(hasAtMostTwoDecimals(0.001)).toBe(false);
  });
});

describe('keepRefusalMessage', () => {
  it('maps every refusal reason keep_lot_for_business can return', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const reasons = [...sql.matchAll(/'reason',\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    const unique = [...new Set(reasons)].filter((r) => r !== 'already_removed_as_');
    expect(unique.length).toBeGreaterThanOrEqual(11);
    for (const r of unique) expect(KEEP_REFUSALS[r], r).toBeTruthy();
    // And nothing stale in the map that the RPC no longer returns.
    expect(Object.keys(KEEP_REFUSALS).sort()).toEqual(unique.sort());
  });

  it('uses the agreed Phase 2/3 wording', () => {
    expect(keepRefusalMessage('lot_on_invoice')).toBe(
      "This lot has been sold or is on a customer's invoice. Keeping sold items isn't available yet.",
    );
    expect(keepRefusalMessage('lot_live_with_bids')).toBe(
      "This lot is in a running auction and already has bids, so it can't be kept now.",
    );
  });

  it('handles the runtime already_removed_as_<kind> reason', () => {
    expect(keepRefusalMessage('already_removed_as_bin_store')).toContain(
      'transferred to Been There Bought That',
    );
    expect(keepRefusalMessage('already_removed_as_weird')).toContain('(weird)');
  });

  it('passes unknown reasons through and has a default', () => {
    expect(keepRefusalMessage('something_new')).toBe('something_new');
    expect(keepRefusalMessage(undefined)).toBe('Could not keep this item.');
  });
});

describe('csvCell', () => {
  it('leaves plain values alone and blanks null', () => {
    expect(csvCell('abc')).toBe('abc');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('quotes commas, quotes and newlines, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });
  it('defuses spreadsheet formulas in text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-dent')).toBe("'-dent");
    expect(csvCell('@sum')).toBe("'@sum");
  });
});

describe('keptCsvLine', () => {
  const row: KeptRow = {
    lot_id: '11111111-1111-1111-1111-111111111111',
    lot_code: 'BIN-0001',
    title: 'Shop vac, 5 gal',
    kept_price_cents: 1250,
    reason: 'Using it in the "back" room',
    kept_by: '22222222-2222-2222-2222-222222222222',
    kept_at: '2026-09-01T15:00:00Z',
    prior_status: 'in_inventory',
  };

  it('has the documented header', () => {
    expect(KEPT_CSV_HEADER.join(',')).toBe(
      'kept_at,lot_code,title,kept_price_dollars,reason,kept_by,prior_status',
    );
  });

  it('formats price in dollars and escapes text', () => {
    expect(keptCsvLine(row, 'Staff A')).toBe(
      '2026-09-01T15:00:00Z,BIN-0001,"Shop vac, 5 gal",12.50,"Using it in the ""back"" room",Staff A,in_inventory',
    );
  });

  it('falls back to the user id and blanks a missing lot code, and shows $0', () => {
    const line = keptCsvLine({ ...row, lot_code: null, kept_price_cents: 0 }, null);
    expect(line.startsWith('2026-09-01T15:00:00Z,,')).toBe(true);
    expect(line).toContain(',0.00,');
    expect(line).toContain(',22222222-2222-2222-2222-222222222222,');
  });
});

describe('summarizeKeeps', () => {
  it('totals all time and since the month start', () => {
    const t = summarizeKeeps(
      [
        { kept_price_cents: 1000, kept_at: '2026-09-15T12:00:00Z' },
        { kept_price_cents: 0, kept_at: '2026-09-01T05:00:00Z' },
        { kept_price_cents: 500, kept_at: '2026-08-31T23:00:00Z' },
      ],
      '2026-09-01T05:00:00.000Z',
    );
    expect(t).toEqual({ count: 3, totalCents: 1500, monthCount: 2, monthTotalCents: 1000 });
  });
  it('is zero for no rows', () => {
    expect(summarizeKeeps([], '2026-09-01T05:00:00Z')).toEqual({
      count: 0,
      totalCents: 0,
      monthCount: 0,
      monthTotalCents: 0,
    });
  });
});
