// #849: the Missing confirmation shows the current bin, keeps the note
// optional, and records a quick reason only when staff choose one.

import { describe, expect, it } from 'vitest';
import {
  MISSING_NOTE_MAX,
  MISSING_NOTE_SEPARATOR,
  MISSING_QUICK_REASONS,
  composeMissingNote,
  missingNoteBudget,
  missingLocationText,
  validateMissingNote,
} from '../missing-confirm';

describe('missingLocationText', () => {
  it('shows the actual bin and its warehouse when set', () => {
    expect(missingLocationText('3-09-01', 'Harrison')).toEqual({
      text: '3-09-01 · Harrison',
      hasBin: true,
    });
    expect(missingLocationText('Right-02-01', null)).toEqual({
      text: 'Right-02-01',
      hasBin: true,
    });
  });

  it('says plainly when no bin is recorded', () => {
    const loc = missingLocationText(null, 'Harrison');
    expect(loc.hasBin).toBe(false);
    expect(loc.text).toMatch(/No bin recorded/i);
    expect(loc.text).not.toContain('Harrison');
  });
});

describe('composeMissingNote', () => {
  it('allows a blank note (no reason sent)', () => {
    expect(composeMissingNote(null, '')).toBeNull();
    expect(composeMissingNote(null, '   ')).toBeNull();
  });

  it('records a quick reason alone', () => {
    expect(composeMissingNote(MISSING_QUICK_REASONS[0], '')).toBe(MISSING_QUICK_REASONS[0]);
  });

  it('keeps a typed note alone', () => {
    expect(composeMissingNote(null, '  behind the pallet  ')).toBe('behind the pallet');
  });

  it('combines the quick reason and the typed note', () => {
    expect(composeMissingNote('Not in the bin', ' checked twice ')).toBe(
      'Not in the bin — checked twice',
    );
  });

  it('never invents the bidder fallback label as a reason', () => {
    for (const text of [composeMissingNote(null, ''), composeMissingNote(null, '  ')]) {
      expect(text).toBeNull();
      expect(text ?? '').not.toMatch(/not found at pickup/i);
    }
  });
});

describe('Missing note budget (#849 RED TEAM follow-up)', () => {
  it('caps typing at what the server will accept beside the selected reason', () => {
    for (const reason of MISSING_QUICK_REASONS) {
      const budget = missingNoteBudget(reason);
      expect(budget).toBe(MISSING_NOTE_MAX - reason.length - MISSING_NOTE_SEPARATOR.length);
      expect(`${reason}${MISSING_NOTE_SEPARATOR}${'x'.repeat(budget)}`.length).toBe(
        MISSING_NOTE_MAX,
      );
      expect(validateMissingNote(reason, 'x'.repeat(budget)).ok).toBe(true);
      expect(validateMissingNote(reason, 'x'.repeat(budget + 1)).ok).toBe(false);
    }
    expect(missingNoteBudget(null)).toBe(MISSING_NOTE_MAX);
    expect(validateMissingNote(null, 'x'.repeat(MISSING_NOTE_MAX)).ok).toBe(true);
    expect(validateMissingNote(null, 'x'.repeat(MISSING_NOTE_MAX + 1)).ok).toBe(false);
  });

  it('validates every composed note at 499/500/501 through the server schema', () => {
    const reason = MISSING_QUICK_REASONS[0];
    for (const typed of [499, 500, 501]) {
      const composed = composeMissingNote(reason, 'x'.repeat(typed));
      expect(composed).not.toBeNull();
      const check = validateMissingNote(reason, 'x'.repeat(typed));
      expect(check.ok).toBe(composed!.length <= MISSING_NOTE_MAX);
      if (!check.ok) expect(check.error).toMatch(/Shorten it/);
    }
    // Typed-only stays within the limit at 500 and fails at 501.
    expect(validateMissingNote(null, 'x'.repeat(500)).ok).toBe(true);
    expect(validateMissingNote(null, 'x'.repeat(501))).toEqual({
      ok: false,
      budget: 500,
      error: 'The note is 501 characters. The limit is 500.',
    });
  });

  it('refuses to add a reason that would overflow, without truncating the note', () => {
    const reason = MISSING_QUICK_REASONS[1];
    const typed = 'y'.repeat(500);
    const budget = missingNoteBudget(reason);
    const check = validateMissingNote(reason, typed);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.budget).toBe(budget);
      expect(check.budget).toBeLessThan(500);
      expect(check.error).toContain(String(budget));
    }
    // The raw composition is still over the limit; the fix is the UI budget,
    // never a silent truncation.
    expect(composeMissingNote(reason, typed)!.length).toBeGreaterThan(500);
  });

  it('accepts the exact budget and a blank note with a reason', () => {
    for (const reason of MISSING_QUICK_REASONS) {
      const budget = missingNoteBudget(reason);
      const check = validateMissingNote(reason, 'z'.repeat(budget));
      expect(check.ok, reason).toBe(true);
      if (check.ok) {
        expect(check.note).toBe(`${reason}${MISSING_NOTE_SEPARATOR}${'z'.repeat(budget)}`);
        expect(check.note!.length).toBe(500);
      }
    }
    expect(validateMissingNote(MISSING_QUICK_REASONS[0], '')).toEqual({
      ok: true,
      note: MISSING_QUICK_REASONS[0],
      budget: missingNoteBudget(MISSING_QUICK_REASONS[0]),
    });
  });
});
