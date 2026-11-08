import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { supabase, track } from '@auction-platform/supabase-client';

/**
 * Watchlist toggle button.
 *
 * Two display modes:
 *   compact=false (default) — full pill button used on the lot detail screen
 *                              ("☆ Watch" / "★ Watching")
 *   compact=true            — small heart icon used as the photo overlay on
 *                              LotCard in the Browse grid ("♡" / "♥")
 */
export function WatchlistToggle({ lotId, compact = false }: { lotId: string; compact?: boolean }) {
  const [watching, setWatching] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        if (!cancelled) setWatching(false);
        return;
      }
      const { data } = await supabase
        .from('watchlist')
        .select('lot_id')
        .eq('lot_id', lotId)
        .eq('bidder_id', u.user.id)
        .maybeSingle();
      if (!cancelled) setWatching(!!data);
    })();
    return () => {
      cancelled = true;
    };
  }, [lotId]);

  async function toggle() {
    if (watching === null || pending) return;
    setPending(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setPending(false);
      return;
    }
    if (watching) {
      await supabase
        .from('watchlist')
        .delete()
        .eq('lot_id', lotId)
        .eq('bidder_id', u.user.id);
      setWatching(false);
      // Pair: watchlist_added when we insert below. Mirrors web's
      // bidder_watchlist_toggled with `watched: false` but split into
      // discrete events so the funnel can join cleanly with web.
      track('watchlist_removed', { lot_id: lotId });
    } else {
      await supabase.from('watchlist').insert({ lot_id: lotId, bidder_id: u.user.id });
      setWatching(true);
      track('watchlist_added', { lot_id: lotId });
    }
    setPending(false);
  }

  if (compact) {
    // Heart overlay for LotCard photo zone — small tap target with a
    // semi-transparent dark pill behind the heart so it reads over any
    // photo background color.
    return (
      <Pressable
        onPress={toggle}
        disabled={watching === null || pending}
        accessibilityRole="button"
        accessibilityLabel={watching ? 'Remove from watchlist' : 'Add to watchlist'}
        accessibilityState={{ checked: watching === true }}
        hitSlop={8}
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: 'rgba(10, 12, 17, 0.75)',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.35,
          shadowRadius: 3,
          elevation: 3,
        }}
      >
        <Text
          style={{
            fontSize: 16,
            // Red heart when watching, white outline heart when not.
            color: watching ? '#ff3b3b' : '#ffffff',
          }}
        >
          {watching ? '♥' : '♡'}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={toggle}
      disabled={watching === null || pending}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: watching ? '#4f8cff' : '#232839',
        backgroundColor: watching ? 'rgba(79, 140, 255, 0.15)' : 'transparent',
        borderRadius: 6,
      }}
    >
      <Text style={{ color: watching ? '#4f8cff' : '#e8eaf0', fontWeight: '500' }}>
        {watching === null ? '…' : watching ? '★ Watching' : '☆ Watch'}
      </Text>
    </Pressable>
  );
}
