// The builder's copy of mig 0345's rule: an item refunded as missing stays
// blocked until intake_at, a location event, or a bin assignment is dated
// after its latest missing mark.

import { describe, it, expect } from 'vitest';
import { unfoundMissingFrom, type MissingSignals } from '../missing-items';

const base = (over: Partial<MissingSignals> = {}): MissingSignals => ({
  missing: [{ lot_id: 'a', created_at: '2026-10-09T19:51:54Z' }],
  intake: [{ id: 'a', intake_at: '2026-09-28T15:44:42Z' }],
  locationEvents: [],
  binAssignments: [],
  ...over,
});

describe('unfoundMissingFrom', () => {
  it('blocks a lot marked missing with no put-away since (PNK4821346 shape)', () => {
    expect(unfoundMissingFrom(base()).get('a')).toBe('2026-10-09T19:51:54Z');
  });

  it('clears on intake_at after the mark', () => {
    const m = unfoundMissingFrom(base({ intake: [{ id: 'a', intake_at: '2026-10-10T00:00:00Z' }] }));
    expect(m.has('a')).toBe(false);
  });

  it('clears on a location event after the mark', () => {
    const m = unfoundMissingFrom(
      base({ locationEvents: [{ lot_id: 'a', occurred_at: '2026-10-11T00:00:00Z' }] }),
    );
    expect(m.has('a')).toBe(false);
  });

  it('clears on a bin assignment after the mark', () => {
    const m = unfoundMissingFrom(
      base({ binAssignments: [{ lot_id: 'a', assigned_at: '2026-10-12T00:00:00Z' }] }),
    );
    expect(m.has('a')).toBe(false);
  });

  it('ignores signals from before the mark', () => {
    const m = unfoundMissingFrom(
      base({
        locationEvents: [{ lot_id: 'a', occurred_at: '2026-10-01T00:00:00Z' }],
        binAssignments: [{ lot_id: 'a', assigned_at: '2026-10-02T00:00:00Z' }],
      }),
    );
    expect(m.has('a')).toBe(true);
  });

  it('uses the LATEST missing mark: found once, missing again, still blocked', () => {
    const m = unfoundMissingFrom(
      base({
        missing: [
          { lot_id: 'a', created_at: '2026-10-01T00:00:00Z' },
          { lot_id: 'a', created_at: '2026-10-09T00:00:00Z' },
        ],
        intake: [{ id: 'a', intake_at: '2026-10-05T00:00:00Z' }],
      }),
    );
    expect(m.get('a')).toBe('2026-10-09T00:00:00Z');
  });

  it('does not let one lot’s put-away clear another', () => {
    const m = unfoundMissingFrom(
      base({ intake: [{ id: 'b', intake_at: '2026-10-12T00:00:00Z' }] }),
    );
    expect(m.has('a')).toBe(true);
  });
});
