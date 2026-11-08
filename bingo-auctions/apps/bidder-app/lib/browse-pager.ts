// Vertical browse pager context (2026-07-07, customer request: stop the
// "tap in, back out, scroll again" loop).
//
// The Browse grid stores its CURRENT filtered/sorted lot list here right
// before pushing /lot/pager; the pager reads it synchronously on mount.
// A module singleton (not route params) because the list can be hundreds of
// ids and both screens live in the same JS process. Never persisted.

import type { LotCardData } from '@auction-platform/domain-bidding';

export type PagerLot = LotCardData;

type PagerContext = {
  lots: PagerLot[];
  startIndex: number;
  /** True when the source list has more pages it hasn't loaded — the pager
   *  shows a "back to the list for more" tail card instead of just ending. */
  hasMore: boolean;
};

let current: PagerContext | null = null;

export function setPagerContext(ctx: PagerContext): void {
  current = ctx;
}

export function getPagerContext(): PagerContext | null {
  return current;
}
