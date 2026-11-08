// Shared bid + watchlist row helpers for the bidder profile surface.
//
// Extracted verbatim from profile/page.tsx (2026-06-05, WEB-NAV) so the
// embedded preview sections on /profile AND the dedicated full-list pages
// (/profile/my-bids, /profile/watchlist) render identically and classify
// bids with the SAME algorithm. No behavior change — this is a lift, not a
// rewrite. The /profile embed and the new pages both import from here.
//
// Why a .tsx module under _lib: it exports both pure helpers (formatMoney,
// classifyBid, CLOSED_STATUSES) and React render components (BidItem,
// WatchlistItem) used by all three server components.
//
// 2026-06-11: this is NOT a 'use client' module. It exports pure helpers
// (formatMoney, classifyBid, CLOSED_STATUSES, isWatchlistRowVisible) that the
// server components /profile, /profile/my-bids and /profile/watchlist call
// during render. The 2026-06-10 'use client' marker (added only to host the
// watchlist Remove button) turned those helpers into client-reference proxies,
// so all three pages threw "Something went wrong" the moment they invoked one
// during SSR. The interactive button now lives in its own client module
// (./WatchlistRemoveButton) and WatchlistItem renders it as a client child —
// a server module rendering a client child is fine; calling a client export
// during SSR is not.

import Link from 'next/link';
import { autoRaiseMessage, type AutoRaiseStatus } from '@auction-platform/shared';
import { WatchlistRemoveButton } from './WatchlistRemoveButton';

// ─── shared types ───────────────────────────────────────────────────────────

export type WatchlistRow = {
  lot_id: string;
  created_at: string;
  lots: {
    id: string;
    lot_code: string;
    title: string;
    status: string;
    current_bid_cents: number | null;
    starting_bid_cents: number;
    close_at: string | null;
    photo_urls: string[] | null;
  } | null;
};

export type BidRow = {
  lot_id: string;
  amount_cents: number;
  max_amount_cents: number;
  placed_at: string;
  lots: {
    id: string;
    lot_code: string;
    title: string;
    status: string;
    current_bid_cents: number | null;
    close_at: string | null;
    winner_bidder_id: string | null;
  } | null;
};

export type BidTone = 'leading' | 'outbid' | 'won' | 'lost';

// ─── watchlist filtering ──────────────────────────────────────────────────────

// Mirror the bidder app's watchlist.tsx CLOSED_STATUSES — lots whose
// auction has ended are hidden from the watchlist (the user can't act on
// them). Rows with a NULL joined lot (LEFT join, RLS-hidden / closed-to-this-
// bidder) are deliberately KEPT so WatchlistItem can render the "Lot no
// longer available" placeholder + Remove button — that's the only way the
// bidder can clear a stuck legacy row.
export const CLOSED_STATUSES = ['ended', 'sold', 'unsold', 'cancelled', 'closed'];

// Customer report 2026-07-09 (mobile browser): closed-auction rows were
// filtered OUT of the watchlist page entirely, so there was nothing to
// remove them from. "Ended" = closed-ish status (incl. won/relisted/
// disposed and both cancel spellings) OR the close time has passed.
const ENDED_STATUSES = new Set([
  ...CLOSED_STATUSES,
  'won',
  'relisted',
  'disposed',
  'canceled',
]);
export function isWatchlistRowEnded(row: WatchlistRow): boolean {
  const lot = row.lots;
  if (!lot) return false; // null-lot rows render their own placeholder+Remove
  if (ENDED_STATUSES.has(lot.status)) return true;
  if (lot.close_at) {
    const ts = Date.parse(lot.close_at);
    if (Number.isFinite(ts) && ts < Date.now()) return true;
  }
  return false;
}

// ── Watch list ordering ─────────────────────────────────────────────────────
//
// Customer request relayed 2026-09-11: "the Watch List be ordered by
// expiration time, with items ending soonest displayed first ... customers
// should also have sorting/filter options, including Ending Soonest."
//
// Both web surfaces ordered by watchlist.created_at DESC — when the bidder
// starred it — so a lot closing in ten minutes sat below one they happened to
// star this morning that runs another week. The whole point of a watch list is
// not missing a close.
//
// The bidder APP already does this (its own sortWatchlist, added 2026-07-14
// off the same feedback). These are the same three modes with the same tie
// handling, deliberately, so a bidder moving between phone and browser sees
// one behaviour rather than two.
export type WatchlistSort = 'ending_soon' | 'ending_late' | 'recent';

export const WATCHLIST_SORTS: { value: WatchlistSort; label: string }[] = [
  { value: 'ending_soon', label: 'Ending soonest' },
  { value: 'ending_late', label: 'Ending latest' },
  { value: 'recent', label: 'Recently added' },
];

/** Narrow an untrusted ?sort= value. Anything unrecognised falls back to the
 *  default rather than rendering an unsorted list. */
export function parseWatchlistSort(raw: string | string[] | undefined): WatchlistSort {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return WATCHLIST_SORTS.some((o) => o.value === v) ? (v as WatchlistSort) : 'ending_soon';
}

/** Sort watchlist rows. Rows whose lot could not be joined (RLS-hidden or
 *  deleted) have no close time to rank by and always sink to the bottom — they
 *  still render, because their placeholder carries the only Remove button that
 *  can clear them. A missing or unparseable close_at sinks the same way, so one
 *  bad timestamp can never take the top slot. */
export function sortWatchlistRows<T extends WatchlistRow>(
  rows: T[],
  mode: WatchlistSort,
): T[] {
  const closeMs = (r: T): number => {
    const ts = r.lots?.close_at ? Date.parse(r.lots.close_at) : NaN;
    return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
  };
  const addedMs = (r: T): number => {
    const ts = r.created_at ? Date.parse(r.created_at) : NaN;
    return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    if (!a.lots && !b.lots) return 0;
    if (!a.lots) return 1;
    if (!b.lots) return -1;
    if (mode === 'recent') return addedMs(b) - addedMs(a);
    const diff = closeMs(a) - closeMs(b);
    return mode === 'ending_soon' ? diff : -diff;
  });
}

export function isWatchlistRowVisible(row: WatchlistRow): boolean {
  // `!row.lots` short-circuits true → null-lot rows are never filtered out.
  return !row.lots || !CLOSED_STATUSES.includes(row.lots.status);
}

// ─── money ────────────────────────────────────────────────────────────────────

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── bid classification (verbatim from profile/page.tsx BidItem) ──────────────

const BID_CLOSED_STATUSES = new Set([
  'sold',
  'closed',
  'unsold',
  'payment_failed_relisted',
]);

/**
 * Classify a single (de-duped) bid into leading / outbid / won / lost.
 *
 * This is the EXACT algorithm that previously lived inline in
 * profile/page.tsx's BidItem (lines ~718-751). Lifted unchanged so the
 * embedded "My bids" preview and the dedicated /profile/my-bids page agree.
 */
export function classifyBid(
  lot: NonNullable<BidRow['lots']>,
  maxAmountCents: number,
  userId: string,
): BidTone {
  const nowMs = Date.now();
  const pastClose = lot.close_at ? new Date(lot.close_at).getTime() <= nowMs : false;
  const closed = pastClose || BID_CLOSED_STATUSES.has(lot.status);

  if (closed) {
    return lot.winner_bidder_id === userId ? 'won' : 'lost';
  }
  // Live — compare current bid against our max. If the lot's
  // current_bid_cents <= our max_amount_cents AND we're the winner
  // (best signal we have without a join), assume leading. Otherwise
  // outbid. This is an approximation; the bidder-app does a richer
  // check via the lot.current_bid leaderboard.
  return lot.winner_bidder_id === userId ||
    (lot.current_bid_cents ?? 0) <= maxAmountCents
    ? 'leading'
    : 'outbid';
}

export const TONE_COLOR: Record<BidTone, string> = {
  leading: 'var(--winning)',
  outbid: 'var(--danger)',
  won: 'var(--success)',
  lost: 'var(--fg-dim)',
};

export const TONE_LABEL: Record<BidTone, string> = {
  leading: 'Leading',
  outbid: 'Outbid',
  won: 'Won',
  lost: 'Lost',
};

// ─── render components ────────────────────────────────────────────────────────

// WatchlistRemoveButton moved to ./WatchlistRemoveButton (2026-06-11) so this
// module stays server-importable (see header). WatchlistItem renders it below.

export function WatchlistItem({
  row,
  withRemove,
}: {
  row: WatchlistRow;
  /** Render an explicit Remove button next to the card (ended auctions —
   *  the lot page's star is pointless once bidding is over). */
  withRemove?: boolean;
}) {
  const lot = row.lots;
  // Lot is RLS-hidden / closed-to-this-bidder (LEFT join returned lots=null).
  // Render a placeholder + Remove button so the bidder can clear a stuck
  // legacy row — mirrors BidItem's "Lot unavailable" placeholder styling.
  if (!lot) {
    return (
      <div
        style={{
          display: 'flex',
          gap: '0.85rem',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.6rem 0.85rem',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          fontSize: 13,
          color: 'var(--fg-muted)',
        }}
      >
        <span>Lot no longer available</span>
        <WatchlistRemoveButton lotId={row.lot_id} />
      </div>
    );
  }
  const cover = lot.photo_urls?.[0];
  const price = lot.current_bid_cents ?? lot.starting_bid_cents;
  const card = (
    <Link
      href={`/lot/${lot.lot_code}`}
      style={{
        display: 'flex',
        gap: '0.85rem',
        padding: '0.6rem',
        borderRadius: 8,
        textDecoration: 'none',
        color: 'inherit',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 6,
          overflow: 'hidden',
          flexShrink: 0,
          background: 'var(--bg)',
        }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lot.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          {formatMoney(price)} &middot; {lot.status}
        </div>
      </div>
    </Link>
  );
  if (!withRemove) return card;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{ flex: 1, minWidth: 0 }}>{card}</div>
      <WatchlistRemoveButton lotId={row.lot_id} />
    </div>
  );
}

export function BidItem({
  row,
  userId,
  autoRaise,
}: {
  row: BidRow;
  userId: string;
  /** BID-CONFIRM (2026-10): set only when the caller has fetched this lot's
   *  auto rows (currently /profile/my-bids, open lots only). Undefined is
   *  treated as "nothing to say" — the line just doesn't render. */
  autoRaise?: AutoRaiseStatus;
}) {
  const lot = row.lots;
  if (!lot) {
    return (
      <div
        style={{
          padding: '0.6rem 0.85rem',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          fontSize: 13,
          color: 'var(--fg-muted)',
        }}
      >
        Lot unavailable (was removed)
      </div>
    );
  }

  const tone = classifyBid(lot, row.max_amount_cents, userId);
  const toneColor = TONE_COLOR[tone];
  const toneLabel = TONE_LABEL[tone];
  // BID-CONFIRM: only while she's actually leading/outbid (an open lot) —
  // same rule as the bidder app's lot page and My Bids tab.
  const autoRaiseLine =
    (tone === 'leading' || tone === 'outbid') && autoRaise
      ? autoRaiseMessage(autoRaise, formatMoney)
      : null;

  return (
    <Link
      href={`/lot/${lot.lot_code}`}
      style={{
        display: 'flex',
        gap: '0.85rem',
        padding: '0.75rem',
        borderRadius: 8,
        textDecoration: 'none',
        color: 'inherit',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lot.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Your max {formatMoney(row.max_amount_cents)} &middot; current{' '}
          {formatMoney(lot.current_bid_cents ?? 0)}
        </div>
        {autoRaiseLine && (
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginTop: 2 }}>
            {autoRaiseLine}
          </div>
        )}
      </div>
      <div
        style={{
          alignSelf: 'center',
          fontSize: 11,
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          color: toneColor,
          flexShrink: 0,
        }}
      >
        {toneLabel}
      </div>
    </Link>
  );
}
