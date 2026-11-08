import { describe, expect, it } from 'vitest';
import {
  auctionHref,
  invoiceHref,
  lotAsListedHref,
  lotHref,
  pairCodesWithIds,
  pickLatestOpenSession,
  pickupSessionHref,
} from '../console-links';

describe('console link hrefs', () => {
  it('builds stable operator paths', () => {
    expect(lotHref('lot-1')).toBe('/lots/lot-1');
    expect(auctionHref('auc-1')).toBe('/auctions/auc-1');
    expect(invoiceHref('inv-1')).toBe('/invoices/inv-1');
    expect(pickupSessionHref('tok')).toBe('/pickups/session/tok');
  });

  it('scopes the "as listed" link under the invoice (not just the lot)', () => {
    expect(lotAsListedHref('inv-1', 'lot-1')).toBe('/invoices/inv-1/lots/lot-1/as-listed');
  });
});

describe('pairCodesWithIds', () => {
  it('zips equal-length arrays', () => {
    expect(pairCodesWithIds(['A', 'B'], ['1', '2'])).toEqual([
      { code: 'A', id: '1' },
      { code: 'B', id: '2' },
    ]);
  });

  it('sets id null when ids is shorter', () => {
    expect(pairCodesWithIds(['A', 'B', 'C'], ['1'])).toEqual([
      { code: 'A', id: '1' },
      { code: 'B', id: null },
      { code: 'C', id: null },
    ]);
  });

  it('handles null inputs', () => {
    expect(pairCodesWithIds(null, null)).toEqual([]);
    expect(pairCodesWithIds(['X'], null)).toEqual([{ code: 'X', id: null }]);
  });

  it('duplicates report links every lot code to its exact lot id', () => {
    expect(pairCodesWithIds(['BIN-1 [live]', 'BIN-2 [draft]'], ['a', 'b'])).toEqual([
      { code: 'BIN-1 [live]', id: 'a' },
      { code: 'BIN-2 [draft]', id: 'b' },
    ]);
  });
});

describe('pickLatestOpenSession', () => {
  const row = (status: string, created_at: string, token = 't') => ({
    status,
    created_at,
    token,
  });

  it('prefers newest open session', () => {
    const rows = [
      row('closed', '2026-01-01T00:00:00Z'),
      row('open', '2026-01-02T00:00:00Z'),
      row('open', '2026-01-03T00:00:00Z'),
    ];
    expect(pickLatestOpenSession(rows)?.created_at).toBe('2026-01-03T00:00:00Z');
  });

  it('falls back to newest of any status when none open', () => {
    const rows = [row('closed', '2026-01-01T00:00:00Z'), row('closed', '2026-01-05T00:00:00Z')];
    expect(pickLatestOpenSession(rows)?.created_at).toBe('2026-01-05T00:00:00Z');
  });

  it('returns null on empty', () => {
    expect(pickLatestOpenSession([])).toBeNull();
  });
});
