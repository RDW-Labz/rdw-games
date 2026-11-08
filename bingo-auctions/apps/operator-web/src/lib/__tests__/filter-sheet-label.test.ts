// filter-sheet-label.test.ts
//
// MOB-01. The mobile filter sheet covers 82vh, so a phone user tapping a
// category never sees the grid re-render behind it — the footer count is the
// only signal the filter did anything. This is the logic behind that count.
//
// It is unit-tested rather than browser-tested because the local database has
// no lots (the seed file is broken), so every local browser run renders the
// zero state and the counted branches would go unexercised. The Playwright
// run covers the wiring — sheet opens, scroll locks, Back closes it — and
// this covers the labels that data would otherwise be needed to see.
//
// Per WORKING_AGREEMENT §7c, each expectation here was confirmed to FAIL
// against a deliberately broken implementation before being trusted.

import { describe, it, expect } from 'vitest';
import { filterSheetLabel, isFilterSheetEmpty } from '@/lib/filter-sheet-label';

describe('filterSheetLabel', () => {
  it('degrades to a plain action when no count is threaded', () => {
    // A caller that hasn't passed resultCount must not render
    // "Show undefined results".
    expect(filterSheetLabel(undefined)).toBe('Show results');
  });

  it('treats zero as a dead end rather than "Show 0 results"', () => {
    expect(filterSheetLabel(0)).toBe('No matches — adjust filters');
  });

  it('singularises exactly one result', () => {
    expect(filterSheetLabel(1)).toBe('Show 1 result');
  });

  it('pluralises everything above one', () => {
    expect(filterSheetLabel(2)).toBe('Show 2 results');
    expect(filterSheetLabel(24)).toBe('Show 24 results');
  });

  it('groups thousands so a big catalogue stays readable', () => {
    expect(filterSheetLabel(12054)).toBe('Show 12,054 results');
  });

  it('never renders a negative count as actionable', () => {
    // Defensive: a caller subtracting its way to -1 should land on the
    // dead-end copy, not "Show -1 results".
    expect(filterSheetLabel(-1)).toBe('No matches — adjust filters');
  });
});

describe('isFilterSheetEmpty', () => {
  it('is false when no count was threaded (button stays usable)', () => {
    expect(isFilterSheetEmpty(undefined)).toBe(false);
  });

  it('is true at zero and below', () => {
    expect(isFilterSheetEmpty(0)).toBe(true);
    expect(isFilterSheetEmpty(-3)).toBe(true);
  });

  it('is false when there are results to show', () => {
    expect(isFilterSheetEmpty(1)).toBe(false);
    expect(isFilterSheetEmpty(24)).toBe(false);
  });
});
