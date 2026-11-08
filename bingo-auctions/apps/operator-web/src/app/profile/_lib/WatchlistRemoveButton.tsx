'use client';

// Client-only Remove button for a watchlist row whose lot is gone/hidden.
//
// Split out of _lib/bids.tsx on 2026-06-11. bids.tsx had been marked
// 'use client' SOLELY to host this interactive button — but that turned its
// pure helpers (classifyBid, isWatchlistRowVisible, formatMoney) into
// client-reference proxies, so the server components /profile,
// /profile/my-bids and /profile/watchlist threw "Something went wrong" the
// moment they called those helpers during server render. Moving the only
// interactive piece into its own 'use client' module lets bids.tsx go back to
// being a plain server-importable module; this button stays a client
// component that WatchlistItem renders (a server component rendering a client
// child is fine — the reverse, calling a client export during SSR, is not).

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

/**
 * Remove button for a watchlist row whose lot is gone/hidden.
 *
 * The lot-card star (WatchlistButton.tsx) is unreachable when the lot is
 * RLS-hidden, so this is the bidder's only way to clear a stuck legacy row.
 * We delete keyed on (bidder_id, lot_id) — the watchlist PK — via the same
 * browser client + watchlist_self_* RLS the star uses; this succeeds even
 * when the joined lot is unreadable because the delete never touches `lots`.
 *
 * bidder_id is resolved client-side from supabase.auth.getUser() (mirrors
 * WatchlistButton.tsx) so neither calling page has to thread userId through
 * WatchlistItem. On success we router.refresh() to drop the row from the
 * server-rendered list.
 */
export function WatchlistRemoveButton({ lotId }: { lotId: string }) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);

  const onClick = useCallback(async () => {
    if (removing || removed) return;
    setRemoving(true);
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data.user?.id;
      if (!userId) {
        // Session expired between SSR and click — bounce to login.
        const next =
          typeof window !== 'undefined'
            ? `${window.location.pathname}${window.location.search}`
            : '/profile';
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }
      const { error } = await supabase
        .from('watchlist')
        .delete()
        .eq('bidder_id', userId)
        .eq('lot_id', lotId);
      if (error) throw error;
      // Optimistically blank the row, then re-fetch the server list so the
      // count + grid update without a full reload.
      setRemoved(true);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not remove.';
      alert(`Could not remove from watchlist: ${msg}`);
      setRemoving(false);
    }
  }, [lotId, removed, removing, router, supabase]);

  if (removed) {
    return (
      <span style={{ fontSize: 12, color: 'var(--fg-dim)', flexShrink: 0 }}>Removed</span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={removing}
      aria-label="Remove from watchlist"
      style={{
        flexShrink: 0,
        padding: '0.4rem 0.75rem',
        fontSize: 12,
        fontWeight: 700,
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg)',
        color: 'var(--danger)',
        cursor: removing ? 'wait' : 'pointer',
        opacity: removing ? 0.6 : 1,
      }}
    >
      {removing ? 'Removing…' : 'Remove'}
    </button>
  );
}
