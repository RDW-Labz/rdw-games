// Pickup tab — entry point to the wedge.
//
// Lists paid invoices grouped by warehouse. Tap a row → /pickup/[invoiceId]
// which opens the warehouse map with the bidder's bins highlighted.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, SectionList, Pressable, RefreshControl, AppState } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { supabase, getCurrentUserId } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';
import { isPickupForfeited, pickupWindowFor } from '@/lib/pickup-card';

type PickupRow = {
  invoice_id: string;
  total_cents: number;
  paid_at: string | null;
  warehouse_id: string;
  warehouse_name: string;
  warehouse_city: string;
  warehouse_state: string;
  // IANA tz of the warehouse — formats the pickup-window line in local time.
  warehouse_tz: string | null;
  // Auction-level pickup window (display-only), mirrors the detail screen.
  pickup_starts_at: string | null;
  pickup_ends_at: string | null;
  operator_name: string;
  lot_count: number;
  staged_count: number;
  picked_up_count: number;
  pickup_status: string | null;
  // #pickup-card (2026-10-21): no-show sweep forfeited it — pickups.status
  // 'forfeited' or every owed line stamped forfeited_at. See lib/pickup-card.
  forfeited: boolean;
  // Completion timestamp from the pickups row. A completed pickup may not flip
  // every lot's bin_assignment to 'picked_up' (e.g. staff RPC closes the row),
  // so this is the authoritative "done" signal alongside pickup_status.
  pickup_completed_at: string | null;
  // Migration 0165 taxonomy: staff_assisted | counter_pickup |
  // self_serve_floor_plan | hybrid (legacy self_serve). counter_pickup was
  // missing here, which mislabeled walk-in pickups (live-test C1/C2).
  effective_mode: 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'self_serve' | 'hybrid';
  // PR-B (mig 0157): operator's no-show policy — drives the badge label
  // when pickup_status === 'no_show' (Forfeited vs Refund pending).
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
};

// Mode labels. staff_assisted was mislabeled "Counter pickup" — that's a
// distinct mode (counter_pickup) where the bidder self-collects from shelves
// and checks out at a counter. staff_assisted = staff retrieve your items.
const MODE_LABEL: Record<string, string> = {
  staff_assisted: 'Staff pickup',
  counter_pickup: 'Counter pickup',
  self_serve_floor_plan: 'Self-serve',
  // Legacy taxonomy (pre-0165) — kept so older rows still render a label.
  self_serve: 'Self-serve',
  hybrid: 'Self-serve',
};

// Default pickup tz when the warehouse has none — mirrors pickup/[id].tsx.
const DEFAULT_PICKUP_TZ = 'America/Chicago';

// Same inline formatter pattern the detail screen (pickup/[id].tsx) uses:
// month/day + time in the warehouse's local tz, falling back to the default
// tz if the warehouse tz is missing or invalid. No new dependency.
function fmtPickupWindow(iso: string, tz: string | null): string {
  const zone = tz && tz.length > 0 ? tz : DEFAULT_PICKUP_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEFAULT_PICKUP_TZ,
    }).format(new Date(iso));
  }
}

// Build the compact one-line pickup-window label for a card. Shows the range
// when both ends exist, else just the side we have. null when neither is set.
function pickupWindowLabel(
  startsAt: string | null,
  endsAt: string | null,
  tz: string | null,
): string | null {
  if (startsAt && endsAt) {
    return `Pickup ${fmtPickupWindow(startsAt, tz)} – ${fmtPickupWindow(endsAt, tz)}`;
  }
  if (startsAt) return `Pickup opens ${fmtPickupWindow(startsAt, tz)}`;
  if (endsAt) return `Pickup by ${fmtPickupWindow(endsAt, tz)}`;
  return null;
}

export default function PickupScreen() {
  const [rows, setRows] = useState<PickupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const uid = await getCurrentUserId();
    if (!uid) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Pull paid invoices with their warehouse + auction pickup mode + lot
    // staging summary. Aggregated client-side; expected scale is ~10s of
    // open pickups per bidder.
    const { data: invoices } = await supabase
      .from('invoices')
      .select(
        `id, total_cents, paid_at, auction_id, operator_id,
         operators:operators_public(business_name),
         auctions(pickup_mode_override, pickup_starts_at, pickup_ends_at),
         pickups(status, completed_at),
         invoice_lots(
           lot_id,
           refunded_at,
           forfeited_at,
           lots(
             warehouse_id, auction_id,
             auctions(pickup_mode_override, pickup_starts_at, pickup_ends_at),
             warehouses(id, name, city, state, timezone, pickup_mode)
           )
         )`,
      )
      .eq('bidder_id', uid)
      // 0245: a partially refunded invoice still owes its un-refunded lots —
      // dropping it here made those items vanish from the customer's list.
      .in('status', ['paid', 'partially_refunded'])
      .order('paid_at', { ascending: false });

    // Full 0165 taxonomy (+ legacy self_serve). Matches pickup/[id].tsx.
    type Mode = 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'self_serve' | 'hybrid';
    type InvShape = {
      id: string;
      total_cents: number;
      paid_at: string | null;
      // PR-B (mig 0157): need operator_id to look up no_show_policy.
      operator_id: string;
      operators: { business_name: string } | null;
      // The auction the customer won in (invoices.auction_id, one FK). Its
      // window survives a relist; the lot's current auction does not.
      auctions: {
        pickup_mode_override: Mode | null;
        pickup_starts_at: string | null;
        pickup_ends_at: string | null;
      } | null;
      pickups: Array<{ status: string; completed_at: string | null }> | { status: string; completed_at: string | null } | null;
      invoice_lots: Array<{
        lot_id: string;
        // 0245: a refunded LINE is no longer owed. Counting it kept collected
        // /refunded items in the customer's "to collect" totals, which is the
        // other half of the customer-vs-staff mismatch.
        refunded_at: string | null;
        forfeited_at: string | null;
        lots: {
          warehouse_id: string;
          auctions: {
            pickup_mode_override: Mode | null;
            pickup_starts_at: string | null;
            pickup_ends_at: string | null;
          } | null;
          warehouses: {
            id: string;
            name: string;
            city: string;
            state: string;
            timezone: string | null;
            pickup_mode: Mode | null;
          } | null;
        } | null;
      }>;
    };

    const out: PickupRow[] = [];

    // Pull per-lot bin_assignment status in a second query to count staged
    // vs picked_up. We compute on a per-invoice basis below.
    const allLotIds: string[] = [];
    for (const inv of (invoices ?? []) as unknown as InvShape[]) {
      for (const il of inv.invoice_lots) allLotIds.push(il.lot_id);
    }
    type AssignmentRow = { lot_id: string; status: string; assigned_at: string };
    const latestByLot = new Map<string, AssignmentRow>();
    if (allLotIds.length) {
      const { data: assignments } = await supabase
        .from('bin_assignments')
        .select('lot_id, status, assigned_at')
        .in('lot_id', allLotIds)
        .order('assigned_at', { ascending: false });
      for (const a of (assignments ?? []) as AssignmentRow[]) {
        if (!latestByLot.has(a.lot_id)) latestByLot.set(a.lot_id, a);
      }
    }

    // PR-B (mig 0157): one-shot policy lookup keyed by operator_id so the
    // no-show row variant can show "Forfeited" vs "Refund pending". We
    // batch by distinct operator to avoid an N+1 across the bidder's
    // invoices. Anon SELECT is allowed via mig 0088 RLS.
    type PolicyRow = {
      operator_id: string;
      no_show_policy: 'full_forfeit' | 'refund_minus_restock';
      version: number;
    };
    const operatorIds = Array.from(
      new Set(((invoices ?? []) as unknown as InvShape[]).map((i) => i.operator_id)),
    );
    const policyByOperator = new Map<
      string,
      'full_forfeit' | 'refund_minus_restock'
    >();
    if (operatorIds.length) {
      const { data: policies } = await supabase
        .from('operator_policies')
        .select('operator_id, no_show_policy, version')
        .in('operator_id', operatorIds)
        .eq('published', true)
        .order('version', { ascending: false });
      for (const p of (policies ?? []) as PolicyRow[]) {
        if (!policyByOperator.has(p.operator_id)) {
          policyByOperator.set(p.operator_id, p.no_show_policy);
        }
      }
    }

    for (const inv of (invoices ?? []) as unknown as InvShape[]) {
      const firstLot = inv.invoice_lots[0]?.lots;
      const wh = firstLot?.warehouses;
      // Invoice's auction first: a relist takes the lot off its auction.
      const auction = inv.auctions ?? firstLot?.auctions;
      if (!wh) continue;

      const mode: Mode = wh.pickup_mode ?? 'staff_assisted';
      const override = auction?.pickup_mode_override ?? null;
      // Resolve to a concrete mode the same way pickup/[id].tsx does so the
      // row's label + CTA + readiness badge all agree with the detail screen:
      // hybrid (and legacy self_serve) collapse to counter_pickup.
      let effective: Mode = override ?? mode;
      if (effective === 'hybrid' || effective === 'self_serve') {
        effective = 'counter_pickup';
      }

      // 0245: drop refunded LINES before counting. A partially refunded
      // invoice still belongs on this list for its remaining lots, but the
      // refunded ones are not owed and must not inflate lot_count — that made
      // the customer's totals disagree with what the counter scan showed.
      const owedLots = inv.invoice_lots.filter((il) => !il.refunded_at);
      // Defensive: status should already exclude a fully-refunded invoice, but
      // if the stamps and the status ever disagree, an empty row is worse than
      // no row.
      if (owedLots.length === 0) continue;

      let stagedCt = 0;
      let pickedCt = 0;
      for (const il of owedLots) {
        const a = latestByLot.get(il.lot_id);
        if (!a) continue;
        if (a.status === 'staged') stagedCt += 1;
        else if (a.status === 'picked_up') pickedCt += 1;
      }

      out.push({
        invoice_id: inv.id,
        total_cents: inv.total_cents,
        paid_at: inv.paid_at,
        warehouse_id: wh.id,
        warehouse_name: wh.name,
        warehouse_city: wh.city,
        warehouse_state: wh.state,
        warehouse_tz: wh.timezone ?? null,
        ...pickupWindowFor(inv.auctions, firstLot?.auctions),
        operator_name: inv.operators?.business_name ?? 'Operator',
        lot_count: owedLots.length,
        staged_count: stagedCt,
        picked_up_count: pickedCt,
        // pickups is UNIQUE on invoice_id → PostgREST returns a to-one object,
        // not an array. Reading [0] yielded undefined, so a completed pickup's
        // status/completed_at never populated and the row lingered as active
        // (tester 2026-07-01). Normalize both shapes (matches my-bids/queue).
        pickup_status: (Array.isArray(inv.pickups) ? inv.pickups[0] : inv.pickups)?.status ?? null,
        forfeited: isPickupForfeited(
          (Array.isArray(inv.pickups) ? inv.pickups[0] : inv.pickups)?.status ?? null,
          owedLots.filter((il) => latestByLot.get(il.lot_id)?.status !== 'picked_up'),
        ),
        pickup_completed_at: (Array.isArray(inv.pickups) ? inv.pickups[0] : inv.pickups)?.completed_at ?? null,
        effective_mode: effective,
        // PR-B (mig 0157): defaults to full_forfeit (BidFTA-style) so the
        // no-show row variant has a stable string when an operator has no
        // policy row (shouldn't happen post-0157 trigger seeding).
        no_show_policy: policyByOperator.get(inv.operator_id) ?? 'full_forfeit',
      });
    }

    setRows(out);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep pickup status fresh. useFocusEffect alone only fires on navigation
  // focus, so a pickup the staff completes (staff app / web) WHILE the bidder
  // is standing at the counter with this tab already open would show a stale
  // "Ready to collect" until they leave and return. Add (a) an AppState
  // 'active' refetch (covers lock→unlock at pickup) and (b) a light 20s poll
  // while focused so a just-completed pickup moves to "Completed" on its own.
  useFocusEffect(
    useCallback(() => {
      load();
      const appStateSub = AppState.addEventListener('change', (s) => {
        if (s === 'active') load();
      });
      const poll = setInterval(load, 20_000);
      return () => {
        appStateSub.remove();
        clearInterval(poll);
      };
    }, [load]),
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#8a93a6' }}>Loading…</Text>
      </View>
    );
  }

  // Partition into Active vs Completed so a finished pickup leaves the active
  // list (testers saw picked-up orders lingering as "active"). Done = the
  // pickups row is completed/no_show, or every lot is physically picked up.
  const isDone = (r: PickupRow) =>
    r.pickup_status === 'completed' ||
    r.pickup_status === 'no_show' ||
    r.forfeited ||
    r.pickup_completed_at != null ||
    (r.lot_count > 0 && r.picked_up_count === r.lot_count);
  const activeRows = rows.filter((r) => !isDone(r));
  const doneRows = rows.filter(isDone);
  const sections = [
    ...(activeRows.length ? [{ title: 'Active', data: activeRows }] : []),
    ...(doneRows.length ? [{ title: 'Completed', data: doneRows }] : []),
  ];

  return (
    <View testID="pickup-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <SectionList
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
        sections={sections}
        stickySectionHeadersEnabled={false}
        // Entry point to the combined pickup pass (mig 0241). The pass shipped
        // web-only, so app users had no way to reach it — no cross-invoice walk
        // list and no single counter QR (field report 2026-07-27). Shown
        // whenever anything is still owed; the pass itself handles the
        // feature-flag-off and empty states.
        ListHeaderComponent={
          activeRows.length > 0 ? (
            <Link href="/pickup-pass" asChild>
              <Pressable
                testID="pickup-pass-cta"
                style={{
                  margin: 16,
                  marginBottom: 4,
                  padding: 14,
                  borderRadius: 12,
                  backgroundColor: '#152238',
                  borderWidth: 1,
                  borderColor: '#2a4a7f',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Text style={{ fontSize: 22 }}>▣</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: '#e8eaf0', fontSize: 15, fontWeight: '700' }}>
                    Open pickup pass
                  </Text>
                  <Text style={{ color: '#8a93a6', fontSize: 12.5, marginTop: 2, lineHeight: 17 }}>
                    {activeRows.length > 1
                      ? `One QR + one walking route for all ${activeRows.length} orders`
                      : 'Your walking route and counter QR code'}
                  </Text>
                </View>
                <Text style={{ color: '#4f8cff', fontSize: 18 }}>→</Text>
              </Pressable>
            </Link>
          ) : null
        }
        renderSectionHeader={({ section }) =>
          sections.length > 1 ? (
            <Text
              style={{
                color: '#8a93a6',
                fontSize: 12,
                fontWeight: '700',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                paddingHorizontal: 16,
                paddingTop: 16,
                paddingBottom: 6,
                backgroundColor: colors.bg,
              }}
            >
              {section.title}
            </Text>
          ) : null
        }
        keyExtractor={(r) => r.invoice_id}
        renderItem={({ item }) => {
          // A pickup is complete when the staff RPC closed the pickups row
          // ('completed') OR every lot has been physically picked up (its
          // bin_assignment flipped to 'picked_up'). The second clause means a
          // fully-collected order never falls through to "Preparing your items"
          // just because staged_count dropped to 0 post-pickup.
          const completed =
            item.pickup_status === 'completed' ||
            item.pickup_completed_at != null ||
            (item.lot_count > 0 && item.picked_up_count === item.lot_count);
          // PR-B (mig 0158): cron flips pickups.status to 'no_show' when the
          // operator's pickup_window expires. Row stays visible because the
          // invoice itself is still 'paid'; badge + CTA change to explain
          // the forfeit / refund-pending posture.
          const noShow = item.pickup_status === 'no_show';
          // The sweep writes 'forfeited' (not 'no_show') under full_forfeit;
          // that fell through to "ready to collect" (2026-10-21).
          const forfeited = item.forfeited;
          // C1/C2: in counter_pickup / self_serve_floor_plan the bidder
          // self-collects and staff never "stage" items, so a "preparing /
          // X of N ready" badge is misleading. Those modes get a flat
          // "Ready to collect"; staff_assisted keeps the staging progress.
          const isSelfCollect =
            item.effective_mode === 'counter_pickup' ||
            item.effective_mode === 'self_serve_floor_plan';
          const readinessBadge = forfeited
            ? '⨯ Forfeited'
            : noShow
            ? item.no_show_policy === 'refund_minus_restock'
              ? '⨯ Refund pending'
              : '⨯ Forfeited'
            : completed
              ? '✓ Pickup complete'
              : isSelfCollect
                ? `◉ ${item.lot_count} ready to collect`
                : item.staged_count === item.lot_count
                  ? `◉ All ${item.lot_count} ready`
                  : item.staged_count > 0
                    ? `${item.staged_count} of ${item.lot_count} ready`
                    : 'Preparing your items';
          const badgeColor = noShow || forfeited
            ? '#f87171'
            : completed
              ? '#4ade80'
              : isSelfCollect || item.staged_count === item.lot_count
                ? '#4ade80'
                : '#fbbf24';
          // Compact pickup-window line (warehouse-local), mirroring the browser
          // list. Display-only; null when the auction set no window.
          const windowLabel = pickupWindowLabel(
            item.pickup_starts_at,
            item.pickup_ends_at,
            item.warehouse_tz,
          );
          const cta = noShow || forfeited
            ? 'View details →'
            : completed
              ? 'View receipt →'
              : item.effective_mode === 'self_serve_floor_plan'
                ? 'Open map →'
                : item.effective_mode === 'counter_pickup'
                  ? 'View pickup details →'
                  : 'Open QR check-in →';
          return (
            <Link href={{ pathname: '/pickup/[id]', params: { id: item.invoice_id } }} asChild>
              <Pressable
                style={{
                  padding: 16,
                  borderBottomWidth: 1,
                  borderBottomColor: '#232839',
                  gap: 4,
                }}
              >
                <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>
                  {item.operator_name} · {MODE_LABEL[item.effective_mode] ?? item.effective_mode}
                </Text>
                <Text style={{ color: '#e8eaf0', fontSize: 16, fontWeight: '600' }}>
                  {item.warehouse_name}
                </Text>
                <Text style={{ color: '#8a93a6', fontSize: 13 }}>
                  {item.lot_count} lots · {formatCents(item.total_cents)}
                  {item.warehouse_city ? ` · ${item.warehouse_city}, ${item.warehouse_state}` : ''}
                </Text>
                {windowLabel ? (
                  <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
                    {windowLabel}
                  </Text>
                ) : null}
                <Text
                  testID="bin-staging-count"
                  style={{ color: badgeColor, fontSize: 13, marginTop: 4 }}
                >
                  {readinessBadge}
                </Text>
                <Text style={{ color: '#4f8cff', fontSize: 13, marginTop: 4 }}>{cta}</Text>
              </Pressable>
            </Link>
          );
        }}
        ListEmptyComponent={
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ color: '#e8eaf0', fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
              No pickups yet
            </Text>
            <Text style={{ color: '#8a93a6', textAlign: 'center', lineHeight: 20 }}>
              When you win lots and pay your invoice, this is where you&apos;ll find a map
              of where your items are stored in the warehouse.
            </Text>
          </View>
        }
      />
    </View>
  );
}
