/**
 * WatchlistButton — client-side star overlay on the lot photo.
 *
 * Renders as a 32x32 circular button positioned absolutely at the
 * top-right of the photo zone. Tap toggles the row in `watchlist`
 * via the browser Supabase client (RLS policy `watchlist_self_all`
 * allows the bidder full access to their own rows).
 *
 * State machine
 *   - "unauthenticated"  → clicking pushes /login?next=<current href>.
 *                          Renders a dim/star-outline state so the
 *                          affordance is still visible.
 *   - "watched"          → filled lime star. Click → DELETE row.
 *   - "not-watched"      → outline star. Click → INSERT row.
 *   - "submitting"       → optimistic flip + disabled while the RPC
 *                          completes; on failure we revert and alert.
 *
 * The auth check fires once on mount via supabase.auth.getUser().
 * We deliberately keep this thin — the parent server page passes
 * `initialWatched` so the SSR render matches the eventual hydrated
 * state and we avoid a layout shift on first paint.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { captureWatchlistToggled } from '@/lib/posthog-events';

interface WatchlistButtonProps {
  lotId: string;
  lotCode: string;
  initialWatched: boolean;
}

type AuthState = 'loading' | 'signed-in' | 'signed-out';

export function WatchlistButton({ lotId, lotCode, initialWatched }: WatchlistButtonProps) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [watched, setWatched] = useState<boolean>(initialWatched);
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [userId, setUserId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Resolve auth state once on mount. We only need user.id; if absent we
  // route the click to /login?next= so the bidder lands back here after.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        if (data.user) {
          setUserId(data.user.id);
          setAuthState('signed-in');
        } else {
          setAuthState('signed-out');
        }
      } catch {
        if (!cancelled) setAuthState('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const onClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      // The button lives as a sibling of the card's <Link>, but defensive
      // stopPropagation guards against future wrapping that might bubble
      // the click up to a navigation handler.
      e.preventDefault();
      e.stopPropagation();

      if (authState === 'loading' || submitting) return;

      if (authState === 'signed-out' || !userId) {
        const next =
          typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '/';
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }

      // Optimistic flip.
      const prev = watched;
      const nextWatched = !prev;
      setWatched(nextWatched);
      setSubmitting(true);

      try {
        if (nextWatched) {
          const { error } = await supabase
            .from('watchlist')
            .insert({ bidder_id: userId, lot_id: lotId });
          // Duplicate-key (already watching from another tab) isn't a
          // user-facing failure — treat it as success.
          if (error && error.code !== '23505') throw error;
        } else {
          const { error } = await supabase
            .from('watchlist')
            .delete()
            .eq('bidder_id', userId)
            .eq('lot_id', lotId);
          if (error) throw error;
        }
        captureWatchlistToggled({ lot_code: lotCode, watched: nextWatched });
      } catch (err) {
        // Revert and surface the failure. alert() is intentional — a full
        // toast library is overkill for this single signal.
        setWatched(prev);
        const msg = err instanceof Error ? err.message : 'Watchlist update failed.';
        alert(`Watchlist update failed: ${msg}`);
      } finally {
        setSubmitting(false);
      }
    },
    [authState, lotCode, lotId, submitting, supabase, userId, watched],
  );

  // Visual states. The "muted" state covers both loading and signed-out
  // so the SSR render is stable until auth resolves on the client.
  const isMuted = authState !== 'signed-in';
  const fillColor = watched ? 'var(--accent)' : 'transparent';
  const strokeColor = watched
    ? 'var(--accent)'
    : isMuted
      ? 'var(--fg-dim)'
      : 'var(--fg-muted)';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={watched}
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      disabled={submitting}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 3,
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: '50%',
        background: 'rgba(10, 12, 17, 0.7)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: submitting ? 'wait' : 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        transition: 'transform 0.12s ease, background 0.12s ease',
        opacity: submitting ? 0.7 : 1,
      }}
    >
      {/* Inline SVG star — empty (outline) when not watched, filled when watched.
          Using SVG instead of a font icon keeps the bundle small and lets us
          drive fill/stroke from component state without a CSS module. */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M12 2.5l2.92 6.04 6.58.92-4.78 4.55 1.18 6.49L12 17.5l-5.9 3 1.18-6.49L2.5 9.46l6.58-.92L12 2.5z" />
      </svg>
    </button>
  );
}
