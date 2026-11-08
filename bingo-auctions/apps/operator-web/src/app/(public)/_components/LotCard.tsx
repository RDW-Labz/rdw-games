/**
 * LotCard — reusable lot tile for /browse, /category/[slug], and any
 * horizontal rail that shows individual lots.
 *
 * Structure
 *   <div class="lot-card">                       (relative)
 *     <a> photo + text body          </a>        (the navigable target)
 *     <WatchlistButton/>                          (overlay sibling)
 *   </div>
 *
 * The watchlist button is rendered as a SIBLING of the anchor (not a
 * child) so we don't nest interactive elements — clicking the star
 * never accidentally navigates to /lot/[code] and the markup is valid.
 *
 * Photo zone overlays (z-order, ascending):
 *   z:1 — photo (next/image fill)
 *   z:2 — top-left status pill (one of ending-soon / top-deal / condition)
 *   z:2 — bottom segmented countdown bar
 *   z:3 — top-right watchlist star (sits ON TOP of countdown if they overlap)
 *
 * Badge priority (top-left, single pill):
 *   1. ending-soon  — close_at within 5 minutes of render time
 *   2. top-deal     — current bid less than 1.5× starting_bid
 *   3. condition    — CONDITION_LABEL_MAP lookup
 *
 * MSRP / savings line (when msrp_cents > displayPrice and savings ≥ 10%):
 *   "$105.00  $700.00  -85%"
 *   ─────────  ────────  ─────
 *   accent     muted     red pill
 *
 * The segmented countdown ("3h 12m 04s") is a live client island
 * (<LotCountdown/>) so the seconds tick in real time without making this
 * whole card a client component — the rest of LotCard stays server-rendered
 * (zero JS per grid item beyond the one small countdown island).
 */

import type React from 'react';
import { SafeLotImage } from './SafeImg';
import { WatchlistButton } from './WatchlistButton';
import { LotCountdown } from './LotCountdown';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Lot row shape consumed by the card.
 *
 * `id` is required so the WatchlistButton can scope its insert/delete
 * to the watchlist row. Callers should always select it (every page
 * already does — this just makes it part of the contract).
 *
 * `msrp_cents` is optional: when present and greater than the current
 * displayed price (and savings ≥ 10%), the card renders the retail
 * strikethrough + savings-percent pill MAC.BID-style.
 */
export interface LotCardLot {
  id: string;
  lot_code: string;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string; // ISO timestamp
  bid_count?: number | null;
  condition?: string | null; // 'new' | 'like-new' | 'open-box' | 'tested' | 'as-is'
  msrp_cents?: number | null;
  /**
   * Lot lifecycle status. Optional + additive: when omitted (existing call
   * sites), the card behaves exactly as before (live ticking countdown).
   * Preview-B (2026-06-11): when explicitly 'scheduled', the card renders a
   * static "Upcoming" pill instead of the ticking countdown so a not-yet-open
   * lot doesn't look live. Only status === 'live' (or an absent status) shows
   * the live countdown.
   */
  status?: string | null;
}

export interface LotCardProps {
  lot: LotCardLot;
  className?: string;
  /** Optional query string (e.g. "?bctx=...") appended to the /lot/<code>
   *  link — /browse threads its filter context through so the lot page can
   *  render prev/next navigation. */
  hrefQuery?: string;
  /** Set true when the current viewer has this lot in their watchlist
   *  (resolved by a watchlist join on the parent server query). Anonymous
   *  visitors always get false. */
  initialWatched?: boolean;
}

// ── Badge logic ───────────────────────────────────────────────────────────────

/**
 * Condition value → human-readable display label for the CSS pill badge.
 *
 * Maps BOTH the new pack-aligned slugs (like-new, open-box, …) AND the legacy
 * lot_condition enum values from migration 0001 (appears_new, open_box, …).
 * Keeping both rows ensures the pill renders correctly against whichever
 * schema version is live.
 */
const CONDITION_LABEL_MAP: Record<string, string> = {
  // lot_condition enum values (migration 0001) — what lotting writes.
  // 'APPEARS NEW' (not 'LIKE NEW'): staff attest it LOOKS new, nothing more —
  // matches the mobile LotCard and the owner's accuracy requirement
  // (2026-07-04).
  appears_new: 'APPEARS NEW',
  open_box: 'OPEN BOX',
  good: 'GOOD',
  as_is: 'AS-IS',
  // Legacy hyphenated slugs from older rows/paths — render sensibly.
  new: 'APPEARS NEW',
  'like-new': 'APPEARS NEW',
  'open-box': 'OPEN BOX',
  'as-is': 'AS-IS',
};

type BadgeKind =
  | { type: 'ending-soon' }
  | { type: 'top-deal' }
  | { type: 'condition'; label: string };

function resolveBadge(lot: LotCardLot, nowMs: number): BadgeKind | null {
  const closeMs = new Date(lot.close_at).getTime();

  // 1. Ending soon — closes within 5 minutes
  if (closeMs - nowMs <= 5 * 60 * 1000 && closeMs > nowMs) {
    return { type: 'ending-soon' };
  }

  // 2. Top deal — current bid < 50 % of (starting × 3)
  //    Threshold is 1.5 × starting_bid_cents (half of 3× proxy for retail).
  //    Only fires when there are actual bids — otherwise it's just a starting
  //    price and the heuristic is meaningless.
  const currentBid = lot.current_bid_cents;
  if (currentBid !== null && currentBid < lot.starting_bid_cents * 1.5) {
    return { type: 'top-deal' };
  }

  // 3. Condition label pill
  if (lot.condition) {
    const label = CONDITION_LABEL_MAP[lot.condition];
    if (label) {
      return { type: 'condition', label };
    }
  }

  return null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Returns a compact time-remaining string.
 * Negative diff (already closed) returns "Closed".
 *
 * Kept for the existing footer line — the new segmented pill uses
 * `formatSegmentedTime` below.
 */
function formatTimeRemaining(closeAt: string, nowMs: number): string {
  const diffMs = new Date(closeAt).getTime() - nowMs;
  if (diffMs <= 0) return 'Closed';
  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(totalSecs / 3600);
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.floor(totalSecs / 60);
  if (mins >= 1) return `${mins}m left`;
  return `${totalSecs}s left`;
}

// ── Badge sub-component ───────────────────────────────────────────────────────
//
// All three badge types render as a CSS pill — no image requests, no CDN
// dependency, screen-reader friendly, legible over any photo content.
//
// Shared pill style:
//   position: absolute | top: 8px | left: 8px | border-radius: 999px
//   font: 11px / weight 800 / uppercase / letter-spacing 0.5px
//   drop-shadow for legibility on bright photos
//
// Per-type colours:
//   ending-soon  — urgent red bg, white text
//   top-deal     — accent lime bg, near-black text
//   condition    — accent lime bg, near-black text  (same as top-deal)

const PILL_BASE: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 2,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  lineHeight: 1.4,
  boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
  whiteSpace: 'nowrap',
};

function LotBadge({ badge }: { badge: BadgeKind }) {
  if (badge.type === 'ending-soon') {
    return (
      <div
        aria-label="Ending soon"
        style={{
          ...PILL_BASE,
          background: 'var(--urgent-red)',
          color: '#fff',
        }}
      >
        ENDING SOON
      </div>
    );
  }

  if (badge.type === 'top-deal') {
    return (
      <div
        aria-label="Top deal"
        style={{
          ...PILL_BASE,
          background: 'var(--accent)',
          color: '#0a0c11',
        }}
      >
        TOP DEAL
      </div>
    );
  }

  // Condition pill — label already uppercased by CONDITION_LABEL_MAP
  return (
    <div
      aria-label={badge.label}
      style={{
        ...PILL_BASE,
        background: 'var(--accent)',
        color: '#0a0c11',
      }}
    >
      {badge.label}
    </div>
  );
}

// Preview-B (2026-06-11): static "Upcoming" pill shown on scheduled lots in
// place of the live ticking countdown bar. Sits at the bottom edge of the
// photo zone (same anchor the countdown uses) so the card layout is stable.
// Reuses the muted-elevated chrome so it reads as informational, not urgent.
function LotUpcomingPill() {
  return (
    <div
      aria-label="Upcoming — bidding not open yet"
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        zIndex: 2,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        lineHeight: 1.4,
        background: 'rgba(10, 12, 17, 0.78)',
        color: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        whiteSpace: 'nowrap',
      }}
    >
      Upcoming
    </div>
  );
}

// ── Price line helpers ────────────────────────────────────────────────────────

const SAVINGS_MIN_PERCENT = 10;

interface SavingsInfo {
  /** Rendered savings percent (already rounded, >= SAVINGS_MIN_PERCENT). */
  percent: number;
  /** Retail price in cents — same value as the lot row, narrowed to number. */
  msrpCents: number;
}

function resolveSavings(
  msrpCents: number | null | undefined,
  displayPriceCents: number,
): SavingsInfo | null {
  if (!msrpCents || msrpCents <= 0 || msrpCents <= displayPriceCents) return null;
  const percent = Math.round((1 - displayPriceCents / msrpCents) * 100);
  if (percent < SAVINGS_MIN_PERCENT) return null;
  return { percent, msrpCents };
}

// ── Main component ────────────────────────────────────────────────────────────

export function LotCard({ lot, className, initialWatched = false, hrefQuery = '' }: LotCardProps) {
  // Server component — Date.now() is evaluated at render time on the server.
  // For a live countdown the parent page would need a client component. For
  // the static badge determination this is correct: the badge is set at SSR
  // time and won't re-evaluate until the next navigation/revalidation.
  const nowMs = Date.now();
  const badge = resolveBadge(lot, nowMs);

  const photoUrl = lot.photo_urls?.[0] ?? null;
  const hasBids = lot.current_bid_cents !== null;
  const displayPrice = hasBids ? lot.current_bid_cents! : lot.starting_bid_cents;
  const bidCount = lot.bid_count ?? 0;
  const timeRemaining = formatTimeRemaining(lot.close_at, nowMs);
  const savings = resolveSavings(lot.msrp_cents, displayPrice);

  // Card chrome — wraps both the navigable <a> (photo + text) AND the
  // watchlist button. The button is intentionally a SIBLING so we never
  // nest <button> inside <a>; that would be invalid HTML and would
  // accidentally fire navigation when the user taps the star.
  return (
    <>
      <div
        className={['lot-card', className].filter(Boolean).join(' ')}
        style={{
          position: 'relative',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
          color: 'inherit',
          transition: 'transform 0.15s ease, border-color 0.15s ease',
        }}
      >
        <a
          href={`/lot/${lot.lot_code}${hrefQuery}`}
          style={{
            display: 'block',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          {/* ── Photo zone (3:2 aspect ratio) ── */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '3 / 2',
              background: 'var(--bg-elev)',
              overflow: 'hidden',
            }}
          >
            {photoUrl ? (
              // SafeLotImage (2026-07-05): unoptimized next/image with a
              // dead-URL fallback to the branded placeholder + no-referrer.
              // Hotlinked retail-CDN photos rot individually; a broken-image
              // glyph on a card reads as "site is broken".
              <SafeLotImage
                src={photoUrl}
                alt={lot.title}
                sizes="(max-width: 640px) 50vw, (max-width: 1100px) 50vw, 33vw"
              />
            ) : (
              // No-photo placeholder — branded box illustration served from
              // our own origin (design/generated/no-photo.webp; see
              // scripts/gen-brand-art.mjs). Same 3:2 aspect as lot photos.
              <img
                src="/art/photo/no-photo.webp"
                alt="No photo available"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            )}

            {badge && <LotBadge badge={badge} />}
            {/* Preview-B (2026-06-11): a scheduled lot must not look live, so
                it shows a static "Upcoming" pill instead of the ticking
                countdown. Any other status — including an absent status from
                existing call sites — keeps the live countdown unchanged. */}
            {lot.status === 'scheduled' ? (
              <LotUpcomingPill />
            ) : (
              <LotCountdown closeAt={lot.close_at} />
            )}
          </div>

          {/* ── Text body ── */}
          <div style={{ padding: '0.85rem 1rem 1rem' }}>
            {/* Title — 2-line clamp */}
            <div
              style={{
                fontWeight: 700,
                fontSize: '0.9rem',
                lineHeight: 1.35,
                marginBottom: '0.45rem',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {lot.title}
            </div>

            {/* Price line — current/starting + optional MSRP strikethrough + savings %.
                Wrapping with flex+wrap lets the savings pill break to a second line
                on narrow grids without overlapping the price. */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                gap: '0.4rem',
                marginBottom: '0.35rem',
              }}
            >
              <span
                style={{
                  fontSize: '1rem',
                  fontWeight: 900,
                  letterSpacing: -0.3,
                  color: hasBids ? 'var(--fg)' : 'var(--fg-muted)',
                }}
              >
                {hasBids ? formatMoney(displayPrice) : `Starts at ${formatMoney(displayPrice)}`}
              </span>

              {savings && (
                <>
                  <span
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--fg-muted)',
                      textDecoration: 'line-through',
                      marginLeft: 0,
                    }}
                  >
                    {formatMoney(savings.msrpCents)}
                  </span>
                  <span
                    aria-label={`Save ${savings.percent} percent`}
                    style={{
                      background: 'rgba(255, 59, 59, 0.15)',
                      color: 'var(--danger)',
                      padding: '2px 7px',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: 0.3,
                    }}
                  >
                    -{savings.percent}%
                  </span>
                </>
              )}
            </div>

            {/* Footer — bid count + time remaining */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12,
                color: 'var(--fg-muted)',
              }}
            >
              <span>
                {bidCount === 0
                  ? 'No bids'
                  : `${bidCount} bid${bidCount === 1 ? '' : 's'}`}
              </span>
              <span
                style={{
                  color:
                    timeRemaining === 'Closed'
                      ? 'var(--fg-dim)'
                      : timeRemaining.endsWith('s left')
                        ? 'var(--urgent-red)'
                        : 'var(--fg-muted)',
                }}
              >
                {timeRemaining}
              </span>
            </div>
          </div>
        </a>

        {/* Watchlist star — SIBLING of the anchor, not a child. Clicks
            never bubble to navigation. Always rendered (the button itself
            handles the signed-out → /login redirect). */}
        <WatchlistButton
          lotId={lot.id}
          lotCode={lot.lot_code}
          initialWatched={initialWatched}
        />
      </div>

      {/* Hover styles injected as a scoped <style> block. This avoids adding
          a className dependency on the parent's CSS pipeline and works cleanly
          in both Server and Client component trees. */}
      <style>{`
        .lot-card:hover {
          border-color: var(--accent);
          transform: scale(1.01);
        }
      `}</style>
    </>
  );
}
