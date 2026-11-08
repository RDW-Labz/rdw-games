/**
 * FinalCallClient — interactive island for the /final-call page.
 *
 * Wraps the server-rendered grid in a 'use client' island that:
 *   1. Subscribes to Supabase realtime UPDATE events on `lots`. Each event
 *      either inserts the lot into local state (if it now sits inside the
 *      [now, now+2min] window), updates the bid fields, or removes the lot
 *      (close_at passed / status changed away from 'live').
 *   2. Runs a 15s safety re-poll (`router.refresh()` re-runs the server
 *      component and pipes fresh `initialLots` back in) — in case a realtime
 *      event was dropped, the list self-heals every 15s.
 *   3. Owns the [All lots] / [Mine only] pill toggle. "Mine only" is an
 *      auth-gated URL flag (?mine=1); the SERVER applies the filter on first
 *      load, the client only flips the pill + pushes the URL. Anon users get
 *      routed to /login?next=/final-call?mine=1 on click.
 *   4. Fires a one-shot `captureFinalCallEntered({ source })` on mount.
 *
 * Design note: this component intentionally does NOT re-render countdowns.
 * The LotCard server component computes the badge + time-remaining at SSR
 * time. The 15s safety re-poll bumps the render — the page is in the
 * sub-2-minute window where everything is on the edge of closing, so a
 * stale 15s display is acceptable for v1. If we later want a smooth
 * ticking countdown we can swap LotCard for the segmented countdown
 * variant once Tier 1A lands.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFromListedAuction } from './listed-auctions';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LotCard, type LotCardLot } from '../_components/LotCard';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  captureFinalCallEntered,
  type FinalCallSource,
} from '@/lib/posthog-events';

// ── Types ────────────────────────────────────────────────────────────────────

/** Row shape the server hands us. Mirrors `loadFinalCallLots` in page.tsx. */
export interface FinalCallLot extends LotCardLot {
  id: string;
  warehouse_city: string | null;
}

interface FinalCallClientProps {
  initialLots: FinalCallLot[];
  /** Auctions Final Call may show (listed, non-demo, active), resolved on the
   *  server. A lot that enters the window mid-session is fetched by id here, so
   *  it must pass the same gate or an unlisted test lot leaks in. */
  listedAuctionIds: string[];
  /** True if the user IS signed in (server-resolved). Determines whether
   *  the "Mine only" pill click can flip in-place or must bounce to /login. */
  isAuthed: boolean;
  /** Current URL state. Server already applied these to `initialLots`. */
  mineOnly: boolean;
  /** Source the user came from. Read from `?from=` on the URL — when missing
   *  defaults to 'nav' since the nav link is the canonical entrypoint. */
  source: FinalCallSource;
}

const SAFETY_REPOLL_INTERVAL_MS = 15_000;
/** 2 min window — must match `FINAL_CALL_WINDOW_MS` in live-count.ts. Inlined
 *  here to keep the client bundle from importing a module that pulls
 *  `next/cache` + `@/lib/supabase-admin`. */
const WINDOW_MS = 2 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when a lot's close_at sits inside the (now, now+2min] live window. */
function isInWindow(closeAtIso: string, nowMs: number): boolean {
  const closeMs = new Date(closeAtIso).getTime();
  return closeMs > nowMs && closeMs - nowMs <= WINDOW_MS;
}

/** Subset of lot fields we care about for live-list reconciliation. Mirror
 *  of `lots` columns; nullable because partial UPDATE payloads from
 *  postgres_changes only ship changed columns. */
type LotPatchPayload = {
  id?: string;
  status?: string;
  close_at?: string;
  current_bid_cents?: number | null;
  bid_count?: number;
  deleted_at?: string | null;
};

// ── Component ────────────────────────────────────────────────────────────────

export function FinalCallClient({
  initialLots,
  listedAuctionIds,
  isAuthed,
  mineOnly,
  source,
}: FinalCallClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const listedAuctions = useMemo(() => new Set(listedAuctionIds), [listedAuctionIds]);

  const [lots, setLots] = useState<FinalCallLot[]>(initialLots);

  // Track the initial-lots snapshot so we can replace it when the URL state
  // (mineOnly) changes between renders. Without this the client would keep
  // showing the old filtered list after a navigation.
  useEffect(() => {
    setLots(initialLots);
  }, [initialLots]);

  // ── PostHog: fire-once on mount ─────────────────────────────────────────
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    captureFinalCallEntered({ source });
  }, [source]);

  // ── Apply an UPDATE patch to local state ──────────────────────────────
  //
  // Realtime payloads include both `old` and `new`. We work off `new`; if it
  // shows the row has left the window, we drop it. If it's now in-window and
  // not already present, we fetch the missing columns (photos, title) before
  // adding — the realtime payload only ships the changed columns.
  const reconcilePatch = useCallback(
    async (patch: LotPatchPayload) => {
      if (!patch.id) return;
      const lotId = patch.id;
      const nowMs = Date.now();

      const endedStatuses = new Set(['sold', 'closed', 'unsold', 'paused']);
      const isEnded = patch.status ? endedStatuses.has(patch.status) : false;
      const isDeleted = patch.deleted_at != null;
      const stillInWindow = patch.close_at
        ? isInWindow(patch.close_at, nowMs)
        : null;

      // Removal cases — straightforward.
      if (isEnded || isDeleted || stillInWindow === false) {
        setLots((prev) => prev.filter((l) => l.id !== lotId));
        return;
      }

      // Is the lot already in our list?
      const existing = lots.find((l) => l.id === lotId);
      if (existing) {
        // In-place update of the mutable bid fields + close_at.
        setLots((prev) =>
          prev.map((l) =>
            l.id === lotId
              ? {
                  ...l,
                  close_at: patch.close_at ?? l.close_at,
                  current_bid_cents:
                    patch.current_bid_cents !== undefined
                      ? patch.current_bid_cents
                      : l.current_bid_cents,
                  bid_count: patch.bid_count ?? l.bid_count,
                }
              : l,
          ),
        );
        return;
      }

      // New entry — only fetch if the row appears in-window.
      if (stillInWindow !== true) return;

      // The "Mine only" view is server-filtered; we can't easily tell whether
      // this new lot belongs to the bidder's watched/bid set from client-side
      // alone. Trade-off: skip realtime-inserts while ?mine=1 and let the
      // safety re-poll catch it. Keeps the per-event work minimal + correct.
      if (mineOnly) return;

      const { data, error } = await supabase
        .from('lots')
        .select(
          'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, condition, warehouse_id, auction_id',
        )
        .eq('id', lotId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) return;
      // Same gate as the server list: no unlisted test or demo auction lots.
      // A lot from an auction that opened after this page loaded appears on
      // the next 15s re-poll, which re-resolves the list.
      if (!isFromListedAuction((data as { auction_id?: string | null }).auction_id, listedAuctions)) return;

      const row = data as unknown as {
        id: string;
        lot_code: string;
        title: string;
        photo_urls: string[] | null;
        current_bid_cents: number | null;
        starting_bid_cents: number;
        close_at: string;
        bid_count: number | null;
        condition: string | null;
      };

      setLots((prev) => {
        if (prev.some((l) => l.id === row.id)) return prev;
        return [
          ...prev,
          {
            id: row.id,
            lot_code: row.lot_code,
            title: row.title,
            photo_urls: row.photo_urls,
            current_bid_cents: row.current_bid_cents,
            starting_bid_cents: row.starting_bid_cents,
            close_at: row.close_at,
            bid_count: row.bid_count,
            condition: row.condition,
            warehouse_city: null,
          },
        ].sort((a, b) => a.close_at.localeCompare(b.close_at));
      });
    },
    [lots, mineOnly, supabase, listedAuctions],
  );

  // ── Realtime subscription ──────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('final-call')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lots' },
        (payload) => {
          // INSERT / UPDATE / DELETE all funnel through reconcilePatch — we
          // treat them identically: examine `new` (or `old` for DELETE),
          // decide insert vs update vs remove.
          const newRow = payload.new as LotPatchPayload | null;
          const oldRow = payload.old as LotPatchPayload | null;

          if (payload.eventType === 'DELETE') {
            if (oldRow?.id) {
              setLots((prev) => prev.filter((l) => l.id !== oldRow.id));
            }
            return;
          }
          if (newRow) {
            void reconcilePatch(newRow);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [reconcilePatch, supabase]);

  // ── 15s safety re-poll ─────────────────────────────────────────────────
  //
  // `router.refresh()` re-runs the server component for the current URL
  // (preserves ?mine=1 + filters) and pipes the new `initialLots` back in.
  // The setInterval is the simplest correct way to self-heal — no race
  // conditions because Next caches the in-flight request.
  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, SAFETY_REPOLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [router]);

  // ── Mine-only toggle handler ───────────────────────────────────────────
  const onToggleMine = useCallback(
    (nextMine: boolean) => {
      if (nextMine && !isAuthed) {
        // Bounce to login; come back with ?mine=1 set so the toggle sticks.
        const target = '/final-call?mine=1';
        router.push(`/login?next=${encodeURIComponent(target)}`);
        return;
      }
      const qs = new URLSearchParams(searchParams.toString());
      if (nextMine) qs.set('mine', '1');
      else qs.delete('mine');
      const suffix = qs.toString();
      router.push(suffix ? `/final-call?${suffix}` : '/final-call');
    },
    [isAuthed, router, searchParams],
  );

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Toggle pill — above the grid */}
      <div
        role="group"
        aria-label="Filter Final Call lots"
        style={{
          display: 'inline-flex',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 3,
          gap: 2,
          marginBottom: '1.25rem',
        }}
      >
        <button
          type="button"
          onClick={() => onToggleMine(false)}
          aria-pressed={!mineOnly}
          style={{
            padding: '0.45rem 1.1rem',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            background: !mineOnly ? 'var(--urgent-red)' : 'transparent',
            color: !mineOnly ? '#fff' : 'var(--fg-muted)',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
        >
          All lots
        </button>
        <button
          type="button"
          onClick={() => onToggleMine(true)}
          aria-pressed={mineOnly}
          style={{
            padding: '0.45rem 1.1rem',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            background: mineOnly ? 'var(--urgent-red)' : 'transparent',
            color: mineOnly ? '#fff' : 'var(--fg-muted)',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
        >
          Mine only
        </button>
      </div>

      {lots.length === 0 ? (
        <FinalCallEmptyState mineOnly={mineOnly} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '1.1rem',
          }}
        >
          {lots.map((lot) => (
            <div
              key={lot.id}
              style={{
                // Subtle red glow reinforces the urgency at the card level.
                // Two layers: thin red ring + soft red diffusion. Tuned to
                // sit just inside the card border so it reads as accent
                // rather than highlight.
                borderRadius: 12,
                boxShadow:
                  '0 0 0 1px rgba(255, 59, 59, 0.4), 0 4px 12px rgba(255, 59, 59, 0.1)',
              }}
            >
              <LotCard lot={lot} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FinalCallEmptyState({ mineOnly }: { mineOnly: boolean }) {
  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '3.5rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <img
        src="/art/empty-final-call.webp"
        alt=""
        width={220}
        height={165}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: 12, marginBottom: 16 }}
      />
      <h2 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 8 }}>
        {mineOnly
          ? 'None of your lots are in the rush right now.'
          : 'No lots in the rush right now.'}
      </h2>
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 480,
          margin: '0 auto 1.5rem',
        }}
      >
        Check back in a few minutes — auctions close throughout the day.
      </p>
      <Link
        href="/browse"
        className="btn-primary"
        style={{ padding: '0.7rem 1.4rem', display: 'inline-block' }}
      >
        Browse all auctions
      </Link>
    </div>
  );
}
