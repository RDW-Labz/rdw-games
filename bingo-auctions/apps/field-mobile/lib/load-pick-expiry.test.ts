import { describe, expect, it } from 'vitest';
import { isLoadPickExpired, lastLoadResetAt } from './load-pick-expiry';

const ct = (iso: string) => new Date(iso); // ISO strings below carry their offset

describe('lastLoadResetAt', () => {
  it('daylight time: 04:00 CDT = 09:00Z', () => {
    expect(lastLoadResetAt(ct('2026-10-21T07:00:00-05:00')).toISOString()).toBe('2026-10-21T09:00:00.000Z');
  });
  it('before 04:00 the boundary is the previous day', () => {
    expect(lastLoadResetAt(ct('2026-10-21T03:59:00-05:00')).toISOString()).toBe('2026-10-20T09:00:00.000Z');
  });
  it('late evening Chicago (next UTC day) still uses today', () => {
    expect(lastLoadResetAt(ct('2026-10-20T23:30:00-05:00')).toISOString()).toBe('2026-10-20T09:00:00.000Z');
  });
  it('standard time: 04:00 CST = 10:00Z', () => {
    expect(lastLoadResetAt(ct('2026-12-01T08:00:00-06:00')).toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });
  it('DST ends 2026-11-01: that day resets at 04:00 CST', () => {
    expect(lastLoadResetAt(ct('2026-11-01T05:00:00-06:00')).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(lastLoadResetAt(ct('2026-10-31T05:00:00-05:00')).toISOString()).toBe('2026-10-31T09:00:00.000Z');
  });
  it('DST starts 2027-03-14: that day resets at 04:00 CDT', () => {
    expect(lastLoadResetAt(ct('2027-03-14T05:00:00-05:00')).toISOString()).toBe('2027-03-14T09:00:00.000Z');
    expect(lastLoadResetAt(ct('2027-03-13T05:00:00-06:00')).toISOString()).toBe('2027-03-13T10:00:00.000Z');
  });
});

describe('isLoadPickExpired', () => {
  const now = ct('2026-10-21T07:15:00-05:00');
  it('no load picked → nothing to expire', () => {
    expect(isLoadPickExpired({ defaultLoadId: null, loadSetAt: null }, now)).toBe(false);
  });
  it('picked this morning after 04:00 → kept', () => {
    expect(isLoadPickExpired({ defaultLoadId: 'L', loadSetAt: '2026-10-21T06:50:00-05:00' }, now)).toBe(false);
  });
  it('picked yesterday afternoon → expired', () => {
    expect(isLoadPickExpired({ defaultLoadId: 'L', loadSetAt: '2026-10-20T15:00:00-05:00' }, now)).toBe(true);
  });
  it('picked at 03:00 today → expired at 04:00', () => {
    expect(isLoadPickExpired({ defaultLoadId: 'L', loadSetAt: '2026-10-21T03:00:00-05:00' }, now)).toBe(true);
  });
  it('legacy pick with no time (the 07-09 load) → expired', () => {
    expect(isLoadPickExpired({ defaultLoadId: 'L' }, now)).toBe(true);
    expect(isLoadPickExpired({ defaultLoadId: 'L', loadSetAt: 'garbage' }, now)).toBe(true);
  });
});
