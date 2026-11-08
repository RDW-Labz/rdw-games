import { describe, expect, it } from 'vitest';
import {
  bidderNumberLabel,
  checkStaffAttribution,
  lotActionMessage,
  removalUndoOpen,
  STAFF_NAME_MAX,
} from '../lot-staff-action';

describe('lot staff actions (mig 0471)', () => {
  it('needs a typed name and a reason, trimmed', () => {
    expect(checkStaffAttribution('  ', 'x')).toEqual({ ok: false, error: 'Type your name.' });
    expect(checkStaffAttribution('Tim', '   ')).toEqual({ ok: false, error: 'Say why.' });
    expect(checkStaffAttribution(undefined, undefined).ok).toBe(false);
    expect(checkStaffAttribution('x'.repeat(STAFF_NAME_MAX + 1), 'r').ok).toBe(false);
    expect(checkStaffAttribution(' Tim ', ' strap broken ')).toEqual({ ok: true, value: { staffName: 'Tim', reason: 'strap broken' } });
  });

  it('maps refusal codes to plain words; unknown passes through', () => {
    expect(lotActionMessage('auction_closed')).toMatch(/auction has closed/);
    expect(lotActionMessage('undo_window_passed')).toMatch(/24 hours/);
    expect(lotActionMessage('already_removed_as_destroyed')).toMatch(/"destroyed"/);
    expect(lotActionMessage('something_new')).toBe('something_new');
    expect(lotActionMessage(undefined)).toBe('Could not do that.');
  });

  it('undo of a removal is open for 24 hours only', () => {
    const now = new Date('2026-10-27T20:00:00Z');
    expect(removalUndoOpen('2026-10-26T21:00:00Z', now)).toBe(true);
    expect(removalUndoOpen('2026-10-26T19:59:00Z', now)).toBe(false);
    expect(removalUndoOpen(null, now)).toBe(false);
  });

  it('bid history shows the bidder number only', () => {
    expect(bidderNumberLabel(1042)).toBe('#1042');
    expect(bidderNumberLabel(null)).toBe('—');
  });
});
