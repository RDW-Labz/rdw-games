/**
 * BrowseAutoRefresh — invisible client island that re-renders the current
 * server component via `router.refresh()` so RSC-on-Workers content updates
 * without a manual reload. Two independent triggers, either or both:
 *
 *  • `intervalMs` (default 30s) — periodic poll so lot prices + bid counts stay
 *    fresh in lots mode (the original purpose; the countdown pills tick on their
 *    own via LotCountdown, this handles server-only data like current_bid_cents).
 *
 *  • `boundaries` — epoch-ms auction lifecycle moments (start time, live close
 *    time). The soonest future one schedules a one-shot refresh so the
 *    LIVE / UPCOMING / ENDED badge flips at the boundary without a reload. The
 *    badge is clock-gated server-side (publicAuctionState), but RSC only runs at
 *    request time on CF Workers, so a tab left open went stale until refresh
 *    (reported June 19, 2026). This is the web equivalent of the mobile app's
 *    1Hz clock-gate. Pass `intervalMs={0}` to schedule only on boundaries.
 *
 * `router.refresh()` re-renders in place, preserving filter/search params.
 */

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_POLL_MS = 30_000;
// Fire just AFTER the boundary so the server's clock has also crossed it —
// otherwise the refresh re-renders the same pre-boundary state and reschedules.
const BOUNDARY_BUFFER_MS = 1_500;
// setTimeout is unreliable past ~24.8 days; no point holding a multi-day timer.
const MAX_BOUNDARY_DELAY_MS = 12 * 60 * 60 * 1000;

interface BrowseAutoRefreshProps {
  /** Periodic poll interval in ms. Pass 0 to disable polling. Default 30s. */
  intervalMs?: number;
  /** Epoch-ms lifecycle boundaries; soonest future one triggers a one-shot refresh. */
  boundaries?: Array<number | null | undefined>;
}

export function BrowseAutoRefresh({
  intervalMs = DEFAULT_POLL_MS,
  boundaries,
}: BrowseAutoRefreshProps = {}) {
  const router = useRouter();

  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

  // Stable key so a new array reference with identical contents (fresh RSC
  // payload) doesn't reschedule needlessly.
  const boundaryKey = (boundaries ?? [])
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
    .join(',');

  useEffect(() => {
    if (!boundaryKey) return;
    const now = Date.now();
    const next = boundaryKey
      .split(',')
      .map(Number)
      .filter((t) => t > now + BOUNDARY_BUFFER_MS)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const id = setTimeout(() => router.refresh(), Math.min(next - now, MAX_BOUNDARY_DELAY_MS));
    return () => clearTimeout(id);
  }, [boundaryKey, router]);

  return null;
}
