import { describe, it, expect } from 'vitest';
import { DONE_PICKUP_STATUSES, OPEN_PICKUP_STATUSES, pickupBucket } from '../buckets';

const now = new Date(2026, 9, 8, 12, 0, 0);

describe('pickupBucket', () => {
  it('puts a checked-in pickup at the counter, scheduled or not (the 2026-10-08 miss)', () => {
    expect(pickupBucket({ status: 'checked_in', scheduled_at: null }, now)).toBe('counter');
    expect(pickupBucket({ status: 'checked_in', scheduled_at: '2026-10-01T15:00:00Z' }, now)).toBe('counter');
  });

  it('puts an unscheduled pending pickup in waiting (almost every prod row has no scheduled_at)', () => {
    expect(pickupBucket({ status: 'pending', scheduled_at: null }, now)).toBe('waiting');
  });

  it('puts a pickup scheduled for today in today, and other days in waiting', () => {
    expect(pickupBucket({ status: 'scheduled', scheduled_at: new Date(2026, 9, 8, 15).toISOString() }, now)).toBe('today');
    expect(pickupBucket({ status: 'scheduled', scheduled_at: new Date(2026, 9, 9, 15).toISOString() }, now)).toBe('waiting');
  });

  it('puts completed and no-show pickups in past', () => {
    expect(pickupBucket({ status: 'completed', scheduled_at: null }, now)).toBe('past');
    expect(pickupBucket({ status: 'no_show', scheduled_at: null }, now)).toBe('past');
  });

  it('open statuses include checked_in', () => {
    expect(OPEN_PICKUP_STATUSES).toContain('checked_in');
    expect(DONE_PICKUP_STATUSES).not.toContain('checked_in');
  });
});
