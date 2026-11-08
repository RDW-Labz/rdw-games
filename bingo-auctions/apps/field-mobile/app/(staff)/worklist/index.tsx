// Inventory — mobile list of the operator's lots that haven't been
// added to an auction yet. Two states (mirrors operator-web /inventory):
//   pending_intake — manifest record / draft, item not yet on a shelf
//   in_inventory   — scanned to a bin, ready for the Auction Builder
//
// MVP scope:
//   - Filter pills (All / Pending / In inventory) with counts
//   - Search by lot_code (prefix) or title (substring)
//   - Pull-to-refresh
//   - Tap a row → /inventory/[id] for detail/edit
//   - Empty-state copy guides the user back to lotting
//
// Out of MVP (deferred to backlog):
//   - Bulk actions (delete, change status)
//   - Sort options (default is created_at desc — most recent on top)
//   - Pagination beyond first 50 (unlikely to be hit by a single operator
//     before the Auction Builder pulls items out of inventory)

import { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  RefreshControl,
  SafeAreaView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors, type as typeTokens } from '@auction-platform/design-system';
import {
  useInventoryList,
  type InventoryFilter,
  type InventoryRow,
} from '@/features/lotting/useInventoryList';
import { WarehouseFilterChip } from '@/features/location/WarehouseFilterChip';
import { filterByWarehouseId } from '@/lib/warehouse-filter';
import { isRefundedLot, REFUNDED_TAG } from '@/lib/relist-after-refund';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCents(cents: number | null): string {
  if (cents == null) return '—';
  return '$' + (cents / 100).toFixed(2);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

const CONDITION_LABEL = {
  appears_new: 'New',
  open_box: 'Open Box',
  good: 'Used',
  as_is: 'As-Is',
} as const;

// ── Main screen ───────────────────────────────────────────────────────────────

export default function InventoryHome() {
  const router = useRouter();
  // ?source=X arrives when the operator deep-links from the LotTR hub's
  // "View [Truck X]'s lots" shortcut. Pre-populates the filter so they
  // land on a per-truck view without extra taps.
  const params = useLocalSearchParams<{ source?: string }>();
  const sourceFromUrl = typeof params.source === 'string' ? params.source : '';
  const [filter, setFilter] = useState<InventoryFilter>('all');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>(sourceFromUrl);
  const [warehouseFilterId, setWarehouseFilterId] = useState<string | null>(null);
  const { state, refresh, refreshing, refundedCount } = useInventoryList(filter, search, sourceFilter);
  // A refunded box is not sellable until relisted with a manager PIN, so its
  // row opens Relot (PIN form), not the listing editor.
  const openRow = useCallback(
    (item: InventoryRow) => {
      if (isRefundedLot(item.status)) {
        router.push({ pathname: '/lotting/relot', params: { code: item.lot_code } });
        return;
      }
      router.push(`/worklist/${item.id}`);
    },
    [router],
  );

  const listRows = useMemo(() => {
    if (state.kind !== 'success') return [];
    return filterByWarehouseId(state.rows, warehouseFilterId);
  }, [state, warehouseFilterId]);

  const onRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const counts =
    state.kind === 'success'
      ? state.counts
      : { draft: 0, pending_intake: 0, in_inventory: 0, unsold: 0, forfeited: 0, flagged: 0 };
  // "All" now includes drafts, so its badge has to as well — a total that
  // disagrees with the list it labels is worse than no total.
  const total = counts.draft + counts.pending_intake + counts.in_inventory + counts.unsold;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={s.header}>
        <View>
          <Text style={s.eyebrow}>WORKLIST</Text>
          <Text style={s.title}>Your lots &amp; follow-ups</Text>
        </View>
        <Pressable onPress={() => router.back()} style={s.doneBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>
            Done
          </Text>
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
        <WarehouseFilterChip value={warehouseFilterId} onChange={setWarehouseFilterId} />
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by code or title…"
          placeholderTextColor={colors.textMuted}
          style={s.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {/* Active source-filter chip — shown when ?source= is in the URL
          (deep-link from the LotTR hub) or the operator picked one inline.
          Tap × to clear and see all sources. */}
      {sourceFilter ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-start',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 99,
              backgroundColor: colors.primaryDim,
              borderWidth: 1,
              borderColor: `${colors.primary}66`,
              gap: 8,
            }}
          >
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>
              📦 {sourceFilter}
            </Text>
            <Pressable
              onPress={() => setSourceFilter('')}
              // hitSlop 16 brings the small × visual to a 44pt touch
              // target (UX-P1-3, WCAG 2.2 AA).
              hitSlop={16}
              accessibilityRole="button"
              accessibilityLabel={`Clear source filter ${sourceFilter}`}
              accessibilityHint="Removes the source filter and shows inventory from all sources"
            >
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '900' }}>×</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Filter pills */}
      <View style={s.pillsRow}>
        <FilterPill
          label="All"
          count={total}
          active={filter === 'all'}
          onPress={() => setFilter('all')}
        />
        {/* Drafts first among the status pills: an unfinished listing is the
            only bucket here that represents work someone ABANDONED mid-way,
            and it stayed invisible until 2026-08-20. Everything else in this
            row is work waiting in an orderly queue. */}
        <FilterPill
          label="Drafts"
          count={counts.draft}
          active={filter === 'draft'}
          onPress={() => setFilter('draft')}
        />
        <FilterPill
          label="Pending"
          count={counts.pending_intake}
          active={filter === 'pending_intake'}
          onPress={() => setFilter('pending_intake')}
        />
        <FilterPill
          label="On shelf"
          count={counts.in_inventory}
          active={filter === 'in_inventory'}
          onPress={() => setFilter('in_inventory')}
        />
        <FilterPill
          label="Unsold"
          count={counts.unsold}
          active={filter === 'unsold'}
          onPress={() => setFilter('unsold')}
        />
        <FilterPill
          // W5-UI task #102 (2026-05-27) — "Forfeited returns" section.
          // Short label "Forfeited" matches sibling-pill word count and
          // keeps the row scannable on small Android screens; the longer
          // "Forfeited returns" phrasing lives in the plan doc + commit
          // message. Predicate joins lots → pickups (no_show/forfeited)
          // in useInventoryList.
          label="Forfeited"
          count={counts.forfeited}
          active={filter === 'forfeited'}
          onPress={() => setFilter('forfeited')}
        />
        <FilterPill
          label="Flagged"
          count={counts.flagged}
          active={filter === 'flagged'}
          onPress={() => setFilter('flagged')}
        />
        {/* 0475: hidden until the 'refunded' status exists (probe in useInventoryList). */}
        {refundedCount !== null && (
          <FilterPill
            label="Refunded"
            count={refundedCount}
            active={filter === 'refunded'}
            onPress={() => setFilter('refunded')}
          />
        )}
      </View>

      {/* Content */}
      {state.kind === 'loading' && (
        <View style={s.centered}>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ color: colors.textMuted, marginTop: 12, fontSize: 13 }}>
            Loading inventory…
          </Text>
        </View>
      )}

      {state.kind === 'error' && (
        <View style={s.centered}>
          <Text style={{ color: colors.danger, fontWeight: '800' }}>
            Couldn&apos;t load inventory
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
            {state.error}
          </Text>
          <Pressable onPress={() => void refresh()} style={s.retryBtn}>
            <Text style={{ color: colors.primary, fontWeight: '800' }}>Retry</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'success' && listRows.length === 0 && (
        <View style={s.centered}>
          <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', maxWidth: 280 }}>
            {search.trim() || sourceFilter || warehouseFilterId
              ? 'No matches. Try a different code, title, or warehouse filter.'
              : 'No inventory yet. Use Quick Lot or Scan from the LotTR hub to create your first lot.'}
          </Text>
        </View>
      )}

      {state.kind === 'success' && listRows.length > 0 && (
        <FlatList
          data={listRows}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <Row item={item} onPress={() => openRow(item)} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          // Perf: large inventory lists (1000+ on warehouse-day) chugged
          // on low-end Android. Variable row height precludes
          // getItemLayout but clipping + small window covers the worst
          // case (UX-P1-10 from 2026-05-24 audit).
          removeClippedSubviews
          windowSize={9}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
        />
      )}
    </SafeAreaView>
  );
}

// ── Row component ────────────────────────────────────────────────────────────

function Row({ item, onPress }: { item: InventoryRow; onPress: () => void }) {
  const firstPhoto = item.photo_urls.find((u) => u.trim().length > 0);
  return (
    <Pressable onPress={onPress} style={s.row}>
      <View style={s.thumb}>
        {firstPhoto ? (
          <Image
            source={{ uri: firstPhoto }}
            style={{ flex: 1, borderRadius: 6 }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        ) : (
          <Text style={{ color: colors.textDim, fontSize: 18 }}>📦</Text>
        )}
      </View>

      <View style={{ flex: 1 }}>
        <Text
          style={{ color: colors.primary, fontFamily: 'monospace', fontSize: 11, fontWeight: '900' }}
          numberOfLines={1}
        >
          {lotDisplayCode(item) ?? item.lot_code}
        </Text>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 2 }} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>
            {CONDITION_LABEL[item.condition]}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>
            {formatCents(item.starting_bid_cents)}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 11 }}>
            {(item.status === 'unsold' || item.status === 'relisted') && item.closed_at
              ? `closed ${timeAgo(item.closed_at)}`
              : timeAgo(item.created_at)}
          </Text>
          {/* Relist badge — surfaces when this lot has been (or was) auto-
              relisted at least once. Helps staff see "this is its 2nd run" */}
          {item.relist_count > 0 && (
            <View
              style={{
                backgroundColor: 'rgba(255,184,122,0.12)',
                borderWidth: 1,
                borderColor: '#ffb87a',
                borderRadius: 99,
                paddingHorizontal: 6,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: '#ffb87a', fontSize: 10, fontWeight: '900' }}>
                relist #{item.relist_count}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Status chip — 'relisted' (W5-UI task #102) renders as FORFEITED
          in this list because the only way a lot reaches that status from
          the staff worklist's perspective is via a no_show/forfeited
          pickup. Color matches unsold's red to signal "needs action". */}
      <View
        style={[
          s.statusChip,
          isRefundedLot(item.status)
            ? s.statusPending
            : item.status === 'in_inventory'
            ? s.statusOnShelf
            : item.status === 'unsold'
              ? { backgroundColor: 'rgba(248, 113, 113, 0.12)', borderColor: '#f87171' }
              : item.status === 'relisted'
                ? { backgroundColor: 'rgba(248, 113, 113, 0.12)', borderColor: '#f87171' }
                : s.statusPending,
        ]}
      >
        <Text
          style={{
            color:
              item.status === 'in_inventory'
                ? '#22c55e'
                : item.status === 'unsold' || item.status === 'relisted'
                  ? '#f87171'
                  : '#f59e0b',
            fontSize: 10,
            fontWeight: '900',
            letterSpacing: 0.4,
          }}
        >
          {isRefundedLot(item.status)
            ? REFUNDED_TAG.toUpperCase()
            : item.status === 'in_inventory'
            ? 'ON SHELF'
            : item.status === 'unsold'
              ? 'UNSOLD'
              : item.status === 'relisted'
                ? 'FORFEITED'
                : 'PENDING'}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Filter pill ──────────────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        s.pill,
        active && { backgroundColor: colors.primaryDim, borderColor: `${colors.primary}66` },
      ]}
    >
      <Text style={{ color: active ? colors.primary : colors.textMuted, fontWeight: '800', fontSize: 12 }}>
        {label}
      </Text>
      <Text style={{ color: active ? colors.primary : colors.textDim, fontSize: 11, marginLeft: 6 }}>
        {count}
      </Text>
    </Pressable>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  doneBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    padding: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 14,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.primary}55`,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusPending: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.35)',
  },
  statusOnShelf: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderColor: 'rgba(34,197,94,0.35)',
  },
});
