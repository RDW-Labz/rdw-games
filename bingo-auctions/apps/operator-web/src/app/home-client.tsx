/**
 * Client-side bits of the bidder homepage.
 *
 * The homepage itself is a server component (see page.tsx) — these are
 * the small islands that need to tick once per second for the
 * ending-soon rail countdowns, plus the lot-card UI shared with the rail.
 *
 * Why a separate file: keeps page.tsx readable and lets us mark JUST
 * these components 'use client' instead of forcing the whole page to
 * ship hydration JS.
 *
 * Design language mirrors apps/bidder-app — same heat colors, same
 * countdown shape ("1:42" / "2h 14m" / "3d 4h"), same condition pills.
 */

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const CARD_W = 240; // matches the iOS LotCard width on a phone-ish layout

// ── Shared lot type (just what the homepage queries) ─────────────────────────

export type HomeLotCard = {
  id: string;
  /** Canonical lot_code — used for the /lot/{code} route only. */
  lot_code: string;
  /** Human-facing code: pre-stickered label when bound, else lot_code. */
  display_code: string;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  msrp_cents: number | null;
  bid_count: number;
  close_at: string;
  condition: string | null;
  /** Lot lifecycle status ('scheduled' | 'live' | …). */
  status: string | null;
  /**
   * Whether the lot's auction is actually OPEN on the clock — derived
   * server-side via publicAuctionState (auction status 'live' AND starts_at
   * has passed). A lot is only treated as live when this is true AND
   * status === 'live'; otherwise it renders the "Upcoming" treatment and the
   * close_at countdown is suppressed (a not-yet-open lot's close_at is the
   * full-auction close, not a live "ends in" time).
   */
  auctionOpen: boolean;
};

// ── Pure helpers (forked from packages/design-system to avoid pulling
//    React Native imports into a Next.js client bundle) ─────────────────────

type Heat = 'urgent' | 'closing' | 'live' | 'closed';

function heatFromCloseAt(closeAtIso: string, nowMs: number): Heat {
  const remaining = new Date(closeAtIso).getTime() - nowMs;
  if (remaining <= 0) return 'closed';
  if (remaining < 2 * 60_000) return 'urgent';
  if (remaining < 5 * 60_000) return 'closing';
  return 'live';
}

function heatColor(heat: Heat): string {
  switch (heat) {
    case 'urgent':
      return 'var(--urgent-red)';
    case 'closing':
      return 'var(--warn-yellow)';
    case 'live':
      return 'var(--accent)';
    case 'closed':
      return 'var(--fg-dim)';
  }
}

function formatCountdown(closeAtIso: string, nowMs: number): string {
  const remaining = new Date(closeAtIso).getTime() - nowMs;
  if (remaining <= 0) return 'Closed';
  const totalSec = Math.floor(remaining / 1000);
  const days = Math.floor(totalSec / 86400);
  if (days >= 1) {
    const h = Math.floor((totalSec - days * 86400) / 3600);
    return `${days}d ${h}h`;
  }
  const hours = Math.floor(totalSec / 3600);
  if (hours >= 1) {
    const m = Math.floor((totalSec - hours * 3600) / 60);
    return `${hours}h ${m}m`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCents(cents: number | null | undefined): string {
  const v = cents ?? 0;
  return `$${(v / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

// ── Condition pill color matrix (mirrors LotCard in domain-bidding) ──────────

function conditionStyle(condition: string | null): {
  bg: string;
  fg: string;
  label: string;
} | null {
  if (!condition) return null;
  switch (condition) {
    case 'appears_new':
      return { bg: 'rgba(34,197,94,0.18)', fg: 'var(--accent)', label: 'NEW' };
    case 'open_box':
      return {
        bg: 'rgba(255,214,10,0.18)',
        fg: 'var(--warn-yellow)',
        label: 'OPEN BOX',
      };
    case 'good':
      return {
        bg: 'rgba(255,214,10,0.10)',
        fg: 'var(--warn-yellow)',
        label: 'GOOD',
      };
    case 'as_is':
      return {
        bg: 'rgba(255,59,59,0.18)',
        fg: 'var(--urgent-red)',
        label: 'AS-IS',
      };
    default:
      return null;
  }
}

// ── Live ticking now-clock ────────────────────────────────────────────────────

function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ── Ending-soon rail ─────────────────────────────────────────────────────────

export function EndingSoonRail({ lots }: { lots: HomeLotCard[] }) {
  // No lots → host page hides the section; this component just renders.
  const hasLots = lots.length > 0;
  const now = useNow(hasLots);

  if (!hasLots) {
    return (
      <div
        style={{
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem 1.5rem',
          textAlign: 'center',
          color: 'var(--fg-muted)',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>{'\u{1F340}'}</div>
        <div style={{ fontWeight: 800, color: 'var(--fg)', marginBottom: 6 }}>
          The hunt resets soon.
        </div>
        <div>
          No lots closing in the next few hours. Check back, or
          {' '}
          <Link href="/browse" style={{ color: 'var(--accent)' }}>
            browse upcoming auctions
          </Link>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="hsnap" role="list">
      {lots.map((lot) => (
        <LotCardSmall key={lot.id} lot={lot} now={now} />
      ))}
    </div>
  );
}

function LotCardSmall({ lot, now }: { lot: HomeLotCard; now: number }) {
  // A lot is only LIVE when its auction is open on the clock AND the lot
  // itself is live. A not-yet-open lot's close_at is the full-auction close,
  // so its countdown would lie ("31 min on a 30-min auction") — suppress it
  // and show a static "Upcoming" treatment instead.
  const isOpen = lot.auctionOpen && lot.status === 'live';
  const heat = heatFromCloseAt(lot.close_at, now);
  const isUrgent = isOpen && heat === 'urgent';
  const isClosing = isOpen && heat === 'closing';
  const cover = lot.photo_urls?.[0] ?? null;
  const price = lot.current_bid_cents ?? lot.starting_bid_cents;
  const discountPct =
    lot.msrp_cents && lot.msrp_cents > 0
      ? Math.max(0, Math.round((1 - price / lot.msrp_cents) * 100))
      : null;
  const cond = conditionStyle(lot.condition);

  return (
    <Link
      role="listitem"
      href={`/lot/${lot.lot_code}`}
      style={{
        display: 'block',
        width: CARD_W,
        background: 'var(--bg-elev)',
        border: `1px solid ${
          isUrgent ? 'var(--urgent-red)' : 'var(--border)'
        }`,
        borderRadius: 12,
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {/* 4:3 photo + corner badges. iOS LotCard uses the same shape. */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '4 / 3',
          background: 'var(--bg-elev-2)',
        }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--fg-dim)',
              fontSize: 12,
            }}
          >
            No photo
          </div>
        )}

        {/* Top-left: bid heat */}
        {lot.bid_count > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              background: 'rgba(10,12,17,0.78)',
              color: 'var(--fg)',
              padding: '4px 8px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span aria-hidden>{'\u{1F525}'}</span>
            <span>{lot.bid_count}</span>
          </div>
        )}

        {/* Top-right: countdown (open lots) or static "Upcoming" pill
            (not-yet-open lots). A scheduled lot's close_at is the full-auction
            close, so a countdown there would be wrong — suppress it and mirror
            LotCard's LotUpcomingPill chrome instead. */}
        {isOpen ? (
          <div
            className={isUrgent ? 'urgent-pulse' : undefined}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              background: isUrgent
                ? 'var(--urgent-red)'
                : isClosing
                ? 'var(--warn-yellow)'
                : 'rgba(34,197,94,0.95)',
              color: isClosing && !isUrgent ? '#000' : '#000',
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: 0.4,
            }}
          >
            {formatCountdown(lot.close_at, now)}
          </div>
        ) : (
          <div
            aria-label="Upcoming — bidding not open yet"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              background: 'rgba(10, 12, 17, 0.78)',
              color: '#fff',
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}
          >
            Upcoming
          </div>
        )}

        {/* Bottom-left: condition */}
        {cond && (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: 8,
              background: cond.bg,
              color: cond.fg,
              padding: '3px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            {cond.label}
          </div>
        )}

        {/* Bottom-right: MSRP discount */}
        {discountPct != null && discountPct >= 30 && (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              right: 8,
              background: 'rgba(10,12,17,0.85)',
              color: 'var(--accent-hi)',
              padding: '3px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: 0.6,
            }}
          >
            {discountPct}% OFF
          </div>
        )}
      </div>

      <div style={{ padding: '10px 12px 14px' }}>
        <div
          style={{
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          {lot.display_code}
        </div>
        <div
          style={{
            color: 'var(--fg)',
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: 36,
            marginBottom: 8,
          }}
        >
          {lot.title}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ color: 'var(--fg-dim)', fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
              {lot.current_bid_cents != null ? 'Current bid' : 'Starts at'}
            </span>
            <span
              style={{
                color: 'var(--fg)',
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.3,
              }}
            >
              {formatCents(price)}
            </span>
          </div>
          <span
            style={{
              color: isOpen ? heatColor(heat) : 'var(--fg-dim)',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {!isOpen
              ? 'Upcoming'
              : heat === 'urgent'
              ? 'Closing'
              : heat === 'closing'
              ? 'Soon'
              : 'Live'}
          </span>
        </div>
      </div>
    </Link>
  );
}

// ── City picker (URL-driven, persisted in localStorage) ──────────────────────
//
// The dropdown is intentionally simple — a <select>. Native iOS / Android
// chrome handles the picker UX better than a custom popover, and we get
// keyboard accessibility for free.

const CITY_STORAGE_KEY = 'clovrbid:city';

export function CityPicker({ cities }: { cities: string[] }) {
  const [value, setValue] = useState<string>('all');
  const router = useRouter();

  // Hydrate from URL + localStorage on mount. Server renders 'all' so
  // we never get a hydration mismatch — the actual selection settles
  // after first paint.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('city');
    if (fromUrl && (fromUrl === 'all' || cities.includes(fromUrl))) {
      setValue(fromUrl);
      try {
        window.localStorage.setItem(CITY_STORAGE_KEY, fromUrl);
      } catch {
        // ignore quota / private-mode errors
      }
      return;
    }
    try {
      const cached = window.localStorage.getItem(CITY_STORAGE_KEY);
      if (cached && (cached === 'all' || cities.includes(cached))) {
        setValue(cached);
      }
    } catch {
      // ignore quota / private-mode errors
    }
  }, [cities]);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setValue(next);
    try {
      window.localStorage.setItem(CITY_STORAGE_KEY, next);
    } catch {
      // ignore quota / private-mode errors
    }

    // NAVIGATE — do not just rewrite the address bar.
    //
    // This used to call window.history.replaceState(), which changes the URL
    // and nothing else: no request, no server render, no refetch. The city
    // landed in the address bar while the page kept showing whatever it had
    // already rendered, so picking "Dodge City" left every Harrison auction on
    // screen. A Harrison customer bought out of a Dodge City auction before we
    // caught it (owner report 2026-08-26).
    //
    // Filtering is done on the server (/browse reads ?city), so the selection
    // has to reach the server. Route to /browse: it is the surface that lists
    // auctions and lots, and "I picked a city" means "show me what's there".
    const url = new URL(window.location.href);
    const onBrowse = url.pathname === '/browse';
    const qs = new URLSearchParams(onBrowse ? url.search : '');
    if (next === 'all') qs.delete('city');
    else qs.set('city', next);
    // A new location invalidates the page you were on.
    qs.delete('page');
    const target = `/browse${qs.toString() ? `?${qs.toString()}` : ''}`;
    router.push(target);
  }

  if (cities.length === 0) return null;

  return (
    <select
      value={value}
      onChange={onChange}
      aria-label="Filter by city"
      style={{
        appearance: 'none',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        color: 'var(--fg)',
        padding: '0.45rem 2rem 0.45rem 0.95rem',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        outline: 'none',
        backgroundImage:
          'url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27 viewBox=%270 0 10 6%27><path d=%27M1 1l4 4 4-4%27 stroke=%27%238a93a6%27 stroke-width=%271.5%27 fill=%27none%27 stroke-linecap=%27round%27/></svg>")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.7rem center',
      }}
    >
      <option value="all">All cities</option>
      {cities.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

// ── Live counter line — fetched client-side from /api/public/stats ───────────

export function LiveStatsLine({
  initialLive,
  initialEndingSoon,
}: {
  initialLive: number;
  initialEndingSoon: number;
}) {
  const [stats, setStats] = useState({
    live: initialLive,
    soon: initialEndingSoon,
  });

  // Refresh once per minute. Cache-Control on the API will collapse most
  // of these to a 304 / 200-from-edge.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await fetch('/api/public/stats', { cache: 'no-store' });
        if (!r.ok) return;
        const body = (await r.json()) as {
          live_lots_count: number;
          ending_within_hour_count: number;
        };
        if (cancelled) return;
        setStats({
          live: body.live_lots_count,
          soon: body.ending_within_hour_count,
        });
      } catch {
        // Network burp — leave the prior value alone.
      }
    }
    const t = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (stats.live <= 0) return null;

  return (
    <p
      style={{
        marginTop: '1.25rem',
        marginBottom: 0,
        fontSize: 13,
        color: 'var(--fg-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: 'var(--accent)',
          boxShadow: '0 0 12px var(--accent)',
        }}
        className="urgent-pulse"
      />
      <span>
        <span style={{ color: 'var(--fg)', fontWeight: 800 }}>
          {stats.live.toLocaleString('en-US')}
        </span>{' '}
        lots live now
      </span>
      {stats.soon > 0 && (
        <>
          <span style={{ color: 'var(--fg-dim)' }}>·</span>
          <span>
            <span style={{ color: 'var(--warn-yellow)', fontWeight: 800 }}>
              {stats.soon.toLocaleString('en-US')}
            </span>{' '}
            ending in the next hour
          </span>
        </>
      )}
    </p>
  );
}
