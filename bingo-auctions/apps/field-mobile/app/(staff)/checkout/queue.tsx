// Picker queue — lots that need to be staged.
//
// "Need staging" = lots from paid invoices that don't yet have a current
// 'staged' bin_assignment. Ordered by most-recent-paid first so staff can
// see the freshest backlog and know staging demand is real.
//
// W6-P2 (2026-05-26): truncation moved server-side.
// Previously: .limit(200) with ascending paid_at → random 200 oldest, no
// indication that records were missing, "oldest first" ordering meant a busy
// day could push the newest urgent items off the visible list.
// Now: .eq('status', 'staged').limit(200) filtered before any client work,
// descending order (most-recent paid first = highest urgency), and a banner
// when exactly 200 rows come back to warn that the view is capped.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, RefreshControl } from 'react-native';
import { Link, useRouter, type Href } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { WarehouseFilterChip } from '@/features/location/WarehouseFilterChip';
import { filterRowsByWarehouse } from '@/lib/warehouse-filter';

const QUEUE_LIMIT = 200;

type QueueRow = {
  lot_id: string;
  lot_code: string | null;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  invoice_id: string;
  paid_at: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  bidder_label: string;
};

export default function PickerQueueScreen() {
  const router = useRouter();
  const [warehouseFilterId, setWarehouseFilterId] = useState<string | null>(null);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // W6-P2: true when exactly QUEUE_LIMIT rows were returned, meaning there
  // may be more that were not fetched.
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    // W6-P2: pull only paid invoices, most-recent first, capped server-side.
    // The .eq('status', 'paid') scopes to invoices that are ready for staging.
    // The .order('paid_at', { ascending: false }) puts freshest invoices at
    // the top so urgent work is never buried.
    // The .limit(QUEUE_LIMIT) is passed to PostgREST as LIMIT — the DB
    // truncates before the network transfer, so we never pull >200 invoice
    // rows regardless of total backlog size.
    const { data: invoices } = await supabase
      .from('invoices')
      .select(
        `id, paid_at,
         pickups(status),
         bidders(email, display_name),
         invoice_lots(
           lot_id,
           lots(
             id, title, lot_code, sticker_code, display_code, warehouse_id,
             auctions(pickup_mode_override),
             warehouses(name, pickup_mode)
           )
         )`,
      )
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(QUEUE_LIMIT);

    type Joined = {
      id: string;
      paid_at: string | null;
      // FIX #6(a): a paid invoice whose pickup is already resolved
      // (completed / no_show / forfeited) is DONE and must not reappear in
      // the staging queue — only 'pending'/'scheduled' still need work.
      // PostgREST returns a to-one embed as an object (or single-element
      // array depending on FK shape); accept both.
      pickups: { status: string } | { status: string }[] | null;
      bidders: { email?: string; display_name?: string | null } | null;
      invoice_lots: Array<{
        lot_id: string;
        lots: {
          id: string;
          title: string;
          lot_code: string | null;
          sticker_code: string | null;
          display_code: string | null;
          warehouse_id: string | null;
          // FIX #6(b): effective pickup mode = COALESCE(auction override,
          // warehouse default). Only staff_assisted/hybrid lots are ever
          // staged; counter_pickup / self_serve_floor_plan are direct or
          // self pickup and never enter this queue.
          auctions: { pickup_mode_override: string | null } | null;
          warehouses: { name?: string; pickup_mode: string | null } | null;
        } | null;
      }>;
    };

    const all = (invoices ?? []) as unknown as Joined[];

    // FIX #6(a): invoice pickup states that still need staging work.
    const STAGEABLE_PICKUP = new Set(['pending', 'scheduled']);
    // FIX #6(b): effective warehouse modes whose lots ever get staged.
    const STAGEABLE_MODE = new Set(['staff_assisted', 'hybrid']);
    // PostgREST gives a to-one embed as object or single-element array.
    const pickupStatusOf = (p: Joined['pickups']): string | null =>
      Array.isArray(p) ? p[0]?.status ?? null : p?.status ?? null;

    // W6-P2: if we got exactly the limit, warn the UI.
    setTruncated(all.length === QUEUE_LIMIT);

    const lotIds = all.flatMap((i) => i.invoice_lots.map((il) => il.lot_id));
    if (lotIds.length === 0) {
      setRows([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const { data: assignments } = await supabase
      .from('bin_assignments')
      .select('lot_id, status, assigned_at')
      .in('lot_id', lotIds)
      .order('assigned_at', { ascending: false });

    // Latest assignment per lot
    const latestByLot = new Map<
      string,
      { status: string; assigned_at: string }
    >();
    for (const a of assignments ?? []) {
      const lotId = a.lot_id as string;
      if (!latestByLot.has(lotId))
        latestByLot.set(lotId, {
          status: a.status as string,
          assigned_at: a.assigned_at as string,
        });
    }

    const queue: QueueRow[] = [];
    for (const inv of all) {
      // FIX #6(a): skip whole invoice once its pickup is resolved. A pickup
      // row only exists once a window is set; a null pickup is still
      // pre-staging work, so treat missing as eligible.
      const pickupStatus = pickupStatusOf(inv.pickups);
      if (pickupStatus && !STAGEABLE_PICKUP.has(pickupStatus)) continue;
      const bidder = inv.bidders;
      const bidderLabel = bidder?.display_name ?? bidder?.email ?? 'Bidder';
      for (const il of inv.invoice_lots) {
        const lot = il.lots;
        if (!lot) continue;
        // FIX #6(b): only staff_assisted/hybrid lots are ever staged.
        // effective = COALESCE(auction override, warehouse mode); default
        // to staff_assisted (column NOT NULL default) so we never wrongly
        // drop a stageable lot when both are null.
        const effectiveMode =
          lot.auctions?.pickup_mode_override ??
          lot.warehouses?.pickup_mode ??
          'staff_assisted';
        if (!STAGEABLE_MODE.has(effectiveMode)) continue;
        const latest = latestByLot.get(il.lot_id);
        if (latest && (latest.status === 'staged' || latest.status === 'picked_up')) continue;
        queue.push({
          lot_id: il.lot_id,
          lot_code: lot.lot_code,
          sticker_code: lot.sticker_code,
          display_code: lot.display_code,
          title: lot.title,
          invoice_id: inv.id,
          paid_at: inv.paid_at,
          warehouse_id: lot.warehouse_id ?? null,
          warehouse_name: lot.warehouses?.name ?? null,
          bidder_label: bidderLabel,
        });
      }
    }

    setRows(queue);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visibleRows = useMemo(
    () => filterRowsByWarehouse(rows, warehouseFilterId, (r) => r.warehouse_id),
    [rows, warehouseFilterId],
  );

  if (loading) {
    return (
      <View
        style={{ flex: 1, backgroundColor: '#0b0d12', alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: '#8a93a6' }}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <WarehouseFilterChip value={warehouseFilterId} onChange={setWarehouseFilterId} />
      </View>
      <View
        style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#232839', flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <Text style={{ color: '#e8eaf0', fontSize: 18, fontWeight: '700', flex: 1 }}>
          {visibleRows.length} to stage
        </Text>
        <Link href={'/checkout/stage' as Href} asChild>
          <Pressable
            style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#4f8cff', borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Scan to stage</Text>
          </Pressable>
        </Link>
      </View>

      {/* W6-P2: truncation banner — only shown when the server returned exactly
          QUEUE_LIMIT rows, indicating there may be more beyond the cap. */}
      {truncated && (
        <View
          style={{
            marginHorizontal: 16,
            marginTop: 10,
            padding: 10,
            backgroundColor: 'rgba(245, 166, 35, 0.08)',
            borderColor: '#f5a623',
            borderWidth: 1,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: '#f5a623', fontSize: 12, fontWeight: '600' }}>
            Showing {QUEUE_LIMIT} most recent — narrow with filters
          </Text>
        </View>
      )}

      <FlatList
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor="#8a93a6"
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        data={visibleRows}
        keyExtractor={(r) => r.lot_id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push('/checkout/stage' as Href)}
            style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#232839' }}
          >
            <Text style={{ color: '#e8eaf0', fontSize: 15, fontWeight: '600' }}>{item.title}</Text>
            <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 4 }}>
              For {item.bidder_label}
              {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
              {item.paid_at ? ` · paid ${new Date(item.paid_at).toLocaleDateString()}` : ''}
            </Text>
            <Text style={{ color: '#4f8cff', fontSize: 12, marginTop: 6 }}>
              Lot {lotDisplayCode(item) ?? item.lot_code ?? item.lot_id.slice(0, 8)} · tap to scan + assign
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ color: '#8a93a6', textAlign: 'center', lineHeight: 20 }}>
              Nothing to stage right now. As bidders pay, items show up here.
            </Text>
          </View>
        }
      />
    </View>
  );
}
