// Recently viewed lots — stored in AsyncStorage. Local-only history;
// no server round-trip. Shown as a horizontal row at the top of the
// browse screen when the bidder isn't actively filtering, so the
// "wait, what was that vanity I just looked at?" question is one tap
// from any home view.
//
// Capped at MAX entries to keep AsyncStorage payloads small. Each
// entry is just the lot UUID — full lot data is re-fetched when the
// rail renders so we always reflect the latest current_bid_cents and
// close_at, not a stale snapshot.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'recently_viewed_lot_ids:v1';
const MAX = 20;

export async function addRecentlyViewed(lotId: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    const next = [lotId, ...list.filter((id) => id !== lotId)].slice(0, MAX);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage failures are benign — recents are a convenience, not
    // load-bearing UI.
  }
}

export async function getRecentlyViewed(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function clearRecentlyViewed(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
