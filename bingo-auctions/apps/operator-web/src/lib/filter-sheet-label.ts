/**
 * Label for the mobile filter sheet's footer button (MOB-01).
 *
 * Pulled out of FilterRail.tsx so it can be unit-tested: that file is a
 * 'use client' component importing next/navigation and next/image, which the
 * node-environment vitest suite can't load. The count logic is the part most
 * worth testing and the part local dev can't exercise — the local database has
 * no lots, so every browser run sees the zero state only.
 *
 * Why the count exists at all: the sheet covers 82vh, so a phone user tapping
 * a category cannot see the grid re-render behind it. The number is the only
 * feedback that the filter did anything. Jared reported this as "the category
 * filter doesn't work"; it always worked, the result was just never visible.
 */
export function filterSheetLabel(resultCount?: number): string {
  // No count threaded by this caller — degrade to a plain close action rather
  // than rendering "Show undefined results".
  if (resultCount === undefined) return 'Show results';

  // Zero is its own state, not "Show 0 results". That label invites a tap and
  // delivers an empty grid — a dead end. Bin-store inventory turns over fast,
  // so empty categories are ordinary rather than an edge case; the caller
  // disables the button on this branch.
  if (resultCount <= 0) return 'No matches — adjust filters';

  const n = resultCount.toLocaleString('en-US');
  return `Show ${n} result${resultCount === 1 ? '' : 's'}`;
}

/** True when the footer button should be non-actionable. */
export function isFilterSheetEmpty(resultCount?: number): boolean {
  return resultCount !== undefined && resultCount <= 0;
}
