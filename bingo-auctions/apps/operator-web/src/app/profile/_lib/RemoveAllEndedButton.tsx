'use client';

// Bulk "Remove all" for the Ended section of /profile/watchlist (customer
// report 2026-07-09, mobile browser): ended/sold/expired lots piled up with
// no way to clear them one-tap-at-a-time on a phone. Deletes every passed
// lot_id keyed on (bidder_id, lot_id) via the same browser client +
// watchlist_self_* RLS the per-row Remove button uses, then router.refresh().

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

export function RemoveAllEndedButton({ lotIds }: { lotIds: string[] }) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);

  const onClick = useCallback(async () => {
    if (removing || removed || lotIds.length === 0) return;
    setRemoving(true);
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data.user?.id;
      if (!userId) {
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
        .in('lot_id', lotIds);
      if (error) throw error;
      setRemoved(true);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not remove.';
      alert(`Could not clear ended lots: ${msg}`);
      setRemoving(false);
    }
  }, [lotIds, removed, removing, router, supabase]);

  if (removed) {
    return <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>Cleared</span>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={removing}
      style={{
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
      {removing ? 'Removing…' : `Remove all (${lotIds.length})`}
    </button>
  );
}
