// Watchlist — every lot the bidder has starred. We surface the lot
// code, current bid, and a heat badge so the watchlist reads at a
// glance: "what am I tracking and what's about to close." When the
// joined lot row can't be loaded (RLS, deleted, status not in the
// bidder's allowlist) we still render the entry as a placeholder so
// the user knows something happened — silent drops are confusing.
//
// June-11 (WATCHLIST-BULK): the per-lot ☆/♥ toggle (WatchlistToggle on
// the lot detail + LotCard) is the only way to un-watch a single lot,
// which is tedious for a 50+ item list once a bunch of auctions close.
// We add a one-tap header action — "Remove closed (N)" — that deletes
// every watchlist row whose joined lot has ended, scoped to the signed-in
// bidder via a single batched delete on (bidder_id, lot_id IN […]). RLS
// (watchlist_self_all: bidder_id = auth.uid()) means we can only ever
// delete our own rows. A lightweight multi-select mode rides on top for
// clearing an arbitrary subset. The main-list status filter is unchanged.

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Image as ExpoImage } from 'expo-image';
import { Link, useFocusEffect } from 'expo-router';
import { supabase, track, getCurrentUserId } from '@auction-platform/supabase-client';
import { formatCents, lotDisplayCode } from '@auction-platform/shared';
import { colors, type, formatCountdown, heatFromCloseAt, heatColor } from '@auction-platform/design-system';

// Mirrors the web watchlist + the original client-side filter below. A lot
// in any of these states is "done" — bidding has ended, so a one-tap
// "Remove closed" can safely clear it from the watchlist.
// 2026-07-10: widened to match the web's ENDED classifier (won/relisted/
// disposed + both cancel spellings) and to also treat a past close_at as
// closed — customer report: ended lots were stuck on the list with no
// obvious way to remove them.
const CLOSED_STATUSES = [
  'ended',
  'sold',
  'unsold',
  'cancelled',
  'closed',
  'won',
  'relisted',
  'disposed',
  'canceled',
];

function lotIsClosed(lot: NonNullable<WatchedLot['lot']>): boolean {
  if (CLOSED_STATUSES.includes(lot.status)) return true;
  if (lot.close_at) {
    const ts = Date.parse(lot.close_at);
    if (Number.isFinite(ts) && ts < Date.now()) return true;
  }
  return false;
}

type WatchedLot = {
  lot_id: string;
  // When the bidder starred the lot — drives the "Recently added" sort.
  created_at: string | null;
  lot: {
    id: string;
    lot_code: string;
    sticker_code: string | null;
    display_code: string | null;
    title: string;
    current_bid_cents: number | null;
    starting_bid_cents: number;
    close_at: string;
    status: string;
  } | null;
};

// Watchlist sort (2026-07-14 customer feedback: default to the auctions
// ending soonest so bidders don't miss closes; keep add-order + latest as
// options). Applied client-side to the already-loaded rows.
type SortMode = 'ending_soon' | 'ending_late' | 'recent';
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'ending_soon', label: 'Ending soonest' },
  { value: 'ending_late', label: 'Ending latest' },
  { value: 'recent', label: 'Recently added' },
];

// Sort the visible rows. Rows with no loaded lot (unavailable) always sink to
// the bottom — they have no close time to rank by. For the two "ending" modes
// a missing/invalid close_at also sinks so a bad timestamp never jumps to top.
function sortWatchlist(rows: WatchedLot[], mode: SortMode): WatchedLot[] {
  const closeMs = (r: WatchedLot): number => {
    const ts = r.lot ? Date.parse(r.lot.close_at) : NaN;
    return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
  };
  const addedMs = (r: WatchedLot): number => {
    const ts = r.created_at ? Date.parse(r.created_at) : NaN;
    return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
  };
  const copy = [...rows];
  copy.sort((a, b) => {
    // Unavailable rows last in every mode.
    if (!a.lot && !b.lot) return 0;
    if (!a.lot) return 1;
    if (!b.lot) return -1;
    if (mode === 'recent') return addedMs(b) - addedMs(a); // newest first
    const diff = closeMs(a) - closeMs(b); // soonest first
    return mode === 'ending_soon' ? diff : -diff;
  });
  return copy;
}

export default function WatchlistScreen() {
  const [items, setItems] = useState<WatchedLot[]>([]);
  // Lot ids of watchlist rows whose lot is closed/ended. These are hidden
  // from the main list (kept out of `items`) but tracked here so the
  // "Remove closed" header action knows exactly which rows to delete.
  const [closedLotIds, setClosedLotIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Multi-select mode (cheap add-on to the one-tap "Remove closed"). When
  // on, tapping a row toggles its lot_id in `selected` instead of opening
  // the lot. "Remove selected" then runs the same batched delete.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Sort order for the visible list. Defaults to "ending soonest" so the
  // auctions closing first are at the top (2026-07-14 customer feedback).
  const [sortMode, setSortMode] = useState<SortMode>('ending_soon');
  // In-flight guard so a double-tap on a bulk action can't fire two
  // delete round-trips.
  const [bulkPending, setBulkPending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const uid = await getCurrentUserId();
    if (!uid) {
      setItems([]);
      setClosedLotIds([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const { data, error: qErr } = await supabase
      .from('watchlist')
      .select(
        'lot_id, created_at, lot:lots(id, lot_code, sticker_code, display_code, title, current_bid_cents, starting_bid_cents, close_at, status)',
      )
      .eq('bidder_id', uid);
    if (qErr) {
      setError(qErr.message);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    // Hide rows whose auction has already ended. We keep `live` and
    // `scheduled` lots, and we preserve rows with a null `lot` so the
    // "Lot unavailable" placeholder still surfaces RLS-hidden or
    // deleted lots.
    const raw = (data ?? []) as unknown as WatchedLot[];
    const visible = raw.filter((item) => !item.lot || !lotIsClosed(item.lot));
    // Collect the closed rows' lot ids for the bulk "Remove closed" action.
    // Rows with a null lot are intentionally excluded — we can't prove their
    // auction ended (could be RLS-hidden but still live), so we leave them
    // for the per-row toggle / multi-select rather than nuking them blindly.
    const closed = raw
      .filter((item) => item.lot && lotIsClosed(item.lot))
      .map((item) => item.lot_id);
    setItems(visible);
    setClosedLotIds(closed);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Batched bulk delete shared by "Remove closed" and "Remove selected".
  // Scoped to the signed-in bidder (bidder_id) AND the given lot ids
  // (lot_id IN […]); RLS additionally enforces bidder_id = auth.uid() so
  // a bidder can never delete another bidder's rows. PostgREST caps URL
  // length, so we chunk the id list to stay well under it on huge lists.
  const bulkRemove = useCallback(
    async (lotIds: string[]): Promise<boolean> => {
      if (lotIds.length === 0) return true;
      const uid = await getCurrentUserId();
      if (!uid) return false;
      const CHUNK = 100;
      for (let i = 0; i < lotIds.length; i += CHUNK) {
        const slice = lotIds.slice(i, i + CHUNK);
        const { error: delErr } = await supabase
          .from('watchlist')
          .delete()
          .eq('bidder_id', uid)
          .in('lot_id', slice);
        if (delErr) {
          setError(delErr.message);
          return false;
        }
      }
      return true;
    },
    [],
  );

  const removeClosed = useCallback(() => {
    if (bulkPending || closedLotIds.length === 0) return;
    const n = closedLotIds.length;
    Alert.alert(
      'Remove closed lots?',
      `This removes ${n} closed ${n === 1 ? 'lot' : 'lots'} from your watchlist. Lots still open stay put.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Remove ${n}`,
          style: 'destructive',
          onPress: async () => {
            setBulkPending(true);
            const ids = closedLotIds;
            const ok = await bulkRemove(ids);
            if (ok) {
              track('watchlist_removed_bulk', { count: ids.length, kind: 'closed' });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              await load();
            } else {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
            }
            setBulkPending(false);
          },
        },
      ],
    );
  }, [bulkPending, closedLotIds, bulkRemove, load]);

  const removeSelected = useCallback(() => {
    if (bulkPending || selected.size === 0) return;
    const ids = Array.from(selected);
    const n = ids.length;
    Alert.alert(
      'Remove from watchlist?',
      `Remove ${n} selected ${n === 1 ? 'lot' : 'lots'} from your watchlist?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Remove ${n}`,
          style: 'destructive',
          onPress: async () => {
            setBulkPending(true);
            const ok = await bulkRemove(ids);
            if (ok) {
              track('watchlist_removed_bulk', { count: ids.length, kind: 'selected' });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              setSelected(new Set());
              setSelectMode(false);
              await load();
            } else {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
            }
            setBulkPending(false);
          },
        },
      ],
    );
  }, [bulkPending, selected, bulkRemove, load]);

  const toggleSelected = useCallback((lotId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) next.delete(lotId);
      else next.add(lotId);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </View>
    );
  }

  // We DON'T pre-filter rows whose lot is null. If the user has 5
  // watched lots and 2 are unavailable, showing 3 with no
  // explanation is more confusing than showing all 5 with a
  // placeholder for the 2.

  // Header is shown whenever there's something actionable: closed lots to
  // clear, or at least one row to multi-select. On a truly empty watchlist
  // we hide it so the empty-state copy stands alone.
  const showHeader = closedLotIds.length > 0 || items.length > 0;
  const sortedItems = sortWatchlist(items, sortMode);
  // Sort control only earns its space once there's more than one lot to order.
  const showSort = items.length > 1;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {error && (
        <View
          style={{
            margin: 12,
            padding: 10,
            backgroundColor: colors.dangerDim,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.danger,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '700' }}>
            Couldn&apos;t load watchlist
          </Text>
          <Text style={{ color: colors.text, fontSize: 12, marginTop: 4 }}>{error}</Text>
        </View>
      )}

      {showHeader && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            paddingHorizontal: 12,
            paddingTop: 12,
            paddingBottom: 4,
          }}
        >
          {/* Left: select-mode toggle (only worth showing when there's a
              list to act on). */}
          {items.length > 0 ? (
            <Pressable
              onPress={() => {
                setSelectMode((on) => !on);
                setSelected(new Set());
              }}
              hitSlop={8}
              style={{ paddingVertical: 6, paddingRight: 8 }}
            >
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
                {selectMode ? 'Cancel' : 'Select'}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}

          {/* Right: the primary one-tap action. In select mode it becomes
              "Remove selected"; otherwise it's "Remove closed (N)". */}
          {selectMode ? (
            <Pressable
              onPress={removeSelected}
              disabled={bulkPending || selected.size === 0}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 14,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected.size === 0 ? colors.border : colors.danger,
                backgroundColor: selected.size === 0 ? 'transparent' : colors.dangerDim,
                opacity: bulkPending ? 0.6 : 1,
              }}
            >
              <Text
                style={{
                  color: selected.size === 0 ? colors.textMuted : colors.danger,
                  fontSize: 13,
                  fontWeight: '800',
                }}
              >
                Remove selected{selected.size > 0 ? ` (${selected.size})` : ''}
              </Text>
            </Pressable>
          ) : (
            closedLotIds.length > 0 && (
              <Pressable
                onPress={removeClosed}
                disabled={bulkPending}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${closedLotIds.length} closed lots from watchlist`}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: bulkPending ? 0.6 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '800' }}>
                  Remove closed ({closedLotIds.length})
                </Text>
              </Pressable>
            )
          )}
        </View>
      )}

      {/* Sort control — hidden in select mode (the header row is busy with
          the remove action) and when there's nothing to reorder. */}
      {showSort && !selectMode && (
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 12,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          {SORT_OPTIONS.map((opt) => {
            const active = sortMode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setSortMode(opt.value)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary : 'transparent',
                }}
              >
                <Text
                  style={{
                    color: active ? '#000' : colors.textMuted,
                    fontSize: 12,
                    fontWeight: '800',
                  }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <FlatList
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textMuted}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        data={sortedItems}
        keyExtractor={(i) => i.lot_id}
        renderItem={({ item }) => (
          <WatchlistRow
            item={item}
            selectMode={selectMode}
            selected={selected.has(item.lot_id)}
            onToggleSelect={() => toggleSelected(item.lot_id)}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center', gap: 16 }}>
            <ExpoImage
              source={require('../../assets/art/empty-watchlist.png')}
              style={{ width: 220, height: 165, borderRadius: 12 }}
              contentFit="cover"
            />
            <Text style={{ color: colors.textMuted, textAlign: 'center', lineHeight: 20 }}>
              No watched lots yet. Tap the heart on any lot in Browse, or use the Watch button on the lot detail screen.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function WatchlistRow({
  item,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: WatchedLot;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const lot = item.lot;
  if (!lot) {
    // Unavailable rows are still selectable so the user can clear a
    // dangling watch (e.g. a lot that was deleted) via multi-select.
    return (
      <Pressable
        onPress={selectMode ? onToggleSelect : undefined}
        disabled={!selectMode}
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: selectMode && selected ? colors.primary : colors.border,
          opacity: 0.6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {selectMode && <SelectDot selected={selected} />}
        <Text style={{ color: colors.textMuted, fontSize: 13, flex: 1 }}>
          Lot unavailable — it may have been removed or is private.
        </Text>
      </Pressable>
    );
  }

  const heat = heatFromCloseAt(lot.close_at, lot.status);
  const heatHex = heatColor(heat);
  const countdown = formatCountdown(lot.close_at);
  const isUrgent = heat === 'urgent';
  const price = lot.current_bid_cents ?? lot.starting_bid_cents;
  const priceLabel = lot.current_bid_cents != null ? 'Current' : 'Starts at';

  const rowBody = (
    <>
      {selectMode && <SelectDot selected={selected} />}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: colors.primary,
            fontFamily: 'monospace',
            fontSize: 11,
            fontWeight: '900',
            letterSpacing: 0.4,
            marginBottom: 2,
          }}
        >
          {lotDisplayCode(lot) ?? lot.lot_code}
        </Text>
        <Text
          style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}
          numberOfLines={2}
        >
          {lot.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
          <Text style={{ color: colors.textMuted, fontSize: 10, ...type.label }}>
            {priceLabel}
          </Text>
          <Text style={{ color: colors.text, fontSize: 14, ...type.display }}>
            {formatCents(price)}
          </Text>
        </View>
      </View>
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 5,
          backgroundColor: heatHex,
          borderRadius: 6,
        }}
      >
        <Text
          style={{
            color:
              heat === 'closing' || heat === 'urgent' ? '#000' : colors.text,
            fontSize: 11,
            fontWeight: '900',
            letterSpacing: 0.4,
          }}
        >
          {countdown}
        </Text>
      </View>
    </>
  );

  const rowStyle = {
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: selectMode && selected ? colors.primary : isUrgent ? colors.danger : colors.border,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  };

  // In select mode the row toggles selection instead of navigating, so we
  // drop the Link wrapper entirely (a tap should never open the lot while
  // the user is picking rows to remove).
  if (selectMode) {
    return (
      <Pressable onPress={onToggleSelect} style={rowStyle}>
        {rowBody}
      </Pressable>
    );
  }

  return (
    <Link href={{ pathname: '/lot/[id]', params: { id: lot.id, source: 'watchlist' } }} asChild>
      <Pressable style={rowStyle}>{rowBody}</Pressable>
    </Link>
  );
}

// Small left-edge checkbox dot shown only in multi-select mode.
function SelectDot({ selected }: { selected: boolean }) {
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primary : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected && (
        <Text style={{ color: '#000', fontSize: 13, fontWeight: '900', lineHeight: 16 }}>✓</Text>
      )}
    </View>
  );
}
