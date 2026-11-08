import { describe, it, expect } from 'vitest';
import { missingMarkFrom, type MissingMarkSignals } from './missing-mark';

const none: MissingMarkSignals = {
  removal: { kind: null, at: null, note: null },
  outcomes: [],
  intakeAt: '2026-09-28T15:44:42Z',
  locationEventAts: [],
  binAssignedAts: [],
};

describe('missingMarkFrom', () => {
  it('no mark → no banner', () => {
    expect(missingMarkFrom(none)).toBeNull();
  });

  it('missing at pickup, never found (PNK4821346 shape) → banner with date and note', () => {
    expect(
      missingMarkFrom({ ...none, outcomes: [{ created_at: '2026-10-09T19:51:54Z', note: 'Not on shelf' }] }),
    ).toEqual({ source: 'pickup', at: '2026-10-09T19:51:54Z', reason: 'Not on shelf' });
  });

  it('blank note → reason null', () => {
    expect(
      missingMarkFrom({ ...none, outcomes: [{ created_at: '2026-10-09T19:51:54Z', note: '  ' }] })?.reason,
    ).toBeNull();
  });

  it.each([
    ['intake', { intakeAt: '2026-10-10T00:00:00Z' }],
    ['location event', { locationEventAts: ['2026-10-10T00:00:00Z'] }],
    ['bin assignment', { binAssignedAts: ['2026-10-10T00:00:00Z'] }],
  ])('found and put away since (%s) → no banner', (_n, over) => {
    expect(
      missingMarkFrom({ ...none, outcomes: [{ created_at: '2026-10-09T00:00:00Z', note: null }], ...over }),
    ).toBeNull();
  });

  it('uses the latest mark', () => {
    expect(
      missingMarkFrom({
        ...none,
        intakeAt: '2026-10-05T00:00:00Z',
        outcomes: [
          { created_at: '2026-10-01T00:00:00Z', note: 'first' },
          { created_at: '2026-10-09T00:00:00Z', note: 'second' },
        ],
      }),
    ).toEqual({ source: 'pickup', at: '2026-10-09T00:00:00Z', reason: 'second' });
  });

  it('removed from inventory as missing → banner from the removal', () => {
    expect(
      missingMarkFrom({ ...none, removal: { kind: 'missing', at: '2026-10-03T12:00:00Z', note: 'Shelf check' } }),
    ).toEqual({ source: 'removal', at: '2026-10-03T12:00:00Z', reason: 'Shelf check' });
  });

  it('other removal kinds are not "missing"', () => {
    expect(missingMarkFrom({ ...none, removal: { kind: 'donated', at: '2026-10-03T12:00:00Z', note: null } })).toBeNull();
  });
});
