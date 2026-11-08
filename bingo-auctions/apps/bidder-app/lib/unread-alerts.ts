// Unread-alert count for the "Alerts" tab badge (owner ask 2026-07-08:
// "a little unread notification thing that when you click it brings you to
// that chronological feed"). The feed itself already lives on the Alerts
// tab (app/(tabs)/notifications.tsx) — this just surfaces "you have N you
// haven't looked at" as the red pill on that tab.
//
// Design: a tiny module-level store with a pub/sub so the tab layout (which
// owns the badge) updates the instant the Alerts screen marks everything
// seen — no polling delay for the clear. A 60s poll keeps the count fresh
// for newly-arrived pushes while the app is foregrounded, matching the
// pickup-badge cadence in (tabs)/_layout.tsx.
//
// "Seen" is a local high-water mark (last time the bidder opened the tab),
// stored in AsyncStorage. Unread = notifications_outbox rows created after
// it. RLS scopes the count to the bidder's own rows (target_user_id =
// auth.uid()), same as the feed query.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';

const LAST_SEEN_KEY = 'alerts_last_seen_at_v1';

type Listener = (count: number) => void;
const listeners = new Set<Listener>();
let current = 0;

function emit() {
  for (const l of listeners) l(current);
}

/** Subscribe to unread-count changes. Fires immediately with the current
 * value and returns an unsubscribe fn. */
export function subscribeUnreadAlerts(cb: Listener): () => void {
  listeners.add(cb);
  cb(current);
  return () => {
    listeners.delete(cb);
  };
}

/** Recount unread rows from the server and notify subscribers. Keeps the
 * previous value on error (transient network) rather than flashing 0. */
export async function refreshUnreadAlerts(): Promise<number> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) {
    current = 0;
    emit();
    return 0;
  }
  const lastSeen = await AsyncStorage.getItem(LAST_SEEN_KEY).catch(() => null);
  let query = supabase
    .from('notifications_outbox')
    .select('id', { count: 'exact', head: true });
  if (lastSeen) query = query.gt('created_at', lastSeen);
  const { count, error } = await query;
  if (error) return current;
  current = count ?? 0;
  emit();
  return current;
}

/** Mark everything up to now as seen (called when the bidder opens the
 * Alerts tab). Clears the badge instantly for all subscribers. */
export async function markAlertsSeen(): Promise<void> {
  await AsyncStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()).catch(() => {});
  current = 0;
  emit();
}
