// Pickup detail — branches on the auction's effective pickup_mode (taxonomy
// extended in migration 0165). Four distinct experiences:
//
//   counter_pickup        → QR (prominent) + lot list WITH bin codes + address
//                           + pickup hours + Google Maps link. NO map, NO
//                           floor-plan empty-state. Bidder walks aisles, finds
//                           lots on labeled shelves, presents QR at counter.
//   staff_assisted        → QR + lot list, NO bin codes (staff retrieves).
//                           No map, no floor-plan UX.
//   self_serve_floor_plan → Full-bleed floor-plan map hero. Bidder walks with
//                           the map, taps off items, Confirm pickup.
//   hybrid                → Resolved at load time to the auction's
//                           pickup_mode_override (falls back to
//                           warehouses.pickup_mode if override is null, then
//                           to 'staff_assisted' as a final defensive default).
//
// Effective mode = COALESCE(auctions.pickup_mode_override, warehouses.pickup_mode).
// Fall back to 'staff_assisted' if neither is set (defensive — column has a
// NOT NULL default but older rows may slip through).
//
// G4: pickup_hours_text from operators is fetched and rendered in WarehouseHeader.
// G5: Google Maps directions link is built from the full warehouse address.
//
// Realtime: bin_assignments updates trigger refetch so the map / staging
// status updates without manual refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Image,
  Pressable,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter, Link } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { isPickupForfeited, pickupWindowFor } from '@/lib/pickup-card';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';
import { PickupMap, type BinPin } from '@auction-platform/domain-fulfillment';
import { BinScanner } from '@auction-platform/domain-fulfillment';
import { PickupScheduler } from '@auction-platform/domain-fulfillment';
import { capturePickupStarted, capturePickupCompleted } from '@/lib/analytics';

// Migration 0165 extended the enum to 4 values. 'self_serve' is legacy —
// kept for backward compat with any row not yet migrated.
type PickupMode = 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'hybrid' | 'self_serve';

type LotWithAssignment = {
  lot_id: string;
  title: string;
  // The human-facing lot code shown next to the title (the same one the browser
  // shows): stickered label (BRN) when bound, else the canonical lot_code.
  displayCode: string | null;
  bin_id: string | null;
  // bin_code is the resolved shelf to show the bidder: the STAGING bin
  // (bin_assignments, set at checkout) when present, else the put-away /
  // intake bin (lots.intake_bin_id) — the lot's actual physical shelf, set at
  // intake long before any staging. In counter_pickup / self_serve modes staff
  // never stage, so the staging bin is null and the intake bin is what the
  // bidder needs to find the item. See H3 (PATCH-live-test-feedback-2026-06-03).
  bin_code: string | null;
  status: 'unstaged' | 'staged' | 'picked_up';
  staging_photo_url: string | null;
  invoice_id: string;
};

type WarehouseInfo = {
  id: string;
  name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
  floorPlanUrl: string | null;
  width: number | null;
  height: number | null;
  entranceX: number | null;
  entranceY: number | null;
  pickupMode: PickupMode;
};

// PR-B (2026-05-29, mig 0157): operator policy fields used for refund-window
// + restock-fee + no-show disclosures. Anon read via mig 0088 RLS.
type OperatorPolicyMinimal = {
  refund_window_post_pickup_hours: number;
  // 0219: gates the bidder-facing "Report a problem" entry only (staff
  // refund tooling reads the window column, not this).
  allow_bidder_disputes: boolean;
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
  restock_fee_cents: number;
  relist_fee_cents: number;
  admin_can_refund_outside_window: boolean;
};

const DEFAULT_OPERATOR_POLICY: OperatorPolicyMinimal = {
  // M6: default to 48h (matches the seed + staff pickup-verify route default).
  // The old 0 meant "all sales final", which silently HID the "Report a
  // problem" entry whenever the operator_policies row failed to load. 48h
  // keeps bidder + staff refund windows in agreement on the fallback path.
  refund_window_post_pickup_hours: 48,
  allow_bidder_disputes: true,
  no_show_policy: 'full_forfeit',
  restock_fee_cents: 500,
  relist_fee_cents: 500,
  admin_can_refund_outside_window: true,
};

export default function PickupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [warehouse, setWarehouse] = useState<WarehouseInfo | null>(null);
  // After hybrid resolution, effectiveMode is always one of the three concrete modes.
  const [effectiveMode, setEffectiveMode] = useState<'counter_pickup' | 'staff_assisted' | 'self_serve_floor_plan'>('staff_assisted');
  const [allBins, setAllBins] = useState<
    Array<{
      id: string;
      code: string;
      aisle: string;
      x_px: number;
      y_px: number;
      landmark_photo_url: string | null;
    }>
  >([]);
  const [lots, setLots] = useState<LotWithAssignment[]>([]);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [pickupWindowStart, setPickupWindowStart] = useState<string | null>(null);
  const [pickupWindowEnd, setPickupWindowEnd] = useState<string | null>(null);
  // 1b (live-test C1/C2): does this operator actually run appointment slots?
  // True only when warehouses.pickup_hours is a non-empty JSONB object. When
  // false (the default {}), staff_assisted hides the time-slot scheduler —
  // staff pickup runs on walk-in counter hours, not booked appointments.
  const [runsAppointments, setRunsAppointments] = useState(false);
  const [checkInToken, setCheckInToken] = useState<string | null>(null);
  const [pickupStatus, setPickupStatus] = useState<string | null>(null);
  // The no-show sweep writes 'forfeited' (not 'no_show') and stamps
  // invoice_lots.forfeited_at; see lib/pickup-card.
  const [forfeited, setForfeited] = useState(false);
  // M6: when the pickup completed, so we can compute the post-pickup refund
  // window for the "Report a problem" entry. null until pickup is finished.
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // G4: operator-level free-form pickup hours text (e.g. "Mon-Fri 10:30-6:00").
  const [pickupHoursText, setPickupHoursText] = useState<string | null>(null);
  // Bidder-collected checkboxes for self-serve / counter_pickup modes (lot_id → true)
  const [collected, setCollected] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  // PR-B (mig 0157): full operator policy for refund + no-show + restock
  // disclosures. null = still loading; DEFAULT_OPERATOR_POLICY applied if
  // the fetch returns no row (edge case — every operator gets seeded a v1).
  const [policy, setPolicy] = useState<OperatorPolicyMinimal | null>(null);

  // One-shot guards for analytics. Without these the events would
  // re-fire on every Realtime refetch / pull-to-refresh.
  const pickupStartedFiredRef = useRef(false);
  const pickupCompletedFiredRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;

    // Pull invoice + lots + warehouse + auction override in one shot. The
    // auction join lets us resolve the effective pickup_mode.
    const { data: invoice } = await supabase
      .from('invoices')
      .select(
        `id,
         auctions(pickup_starts_at, pickup_ends_at),
         invoice_lots(
           lot_id,
           picked_up_at,
           refunded_at,
           forfeited_at,
           lots(
             id, title, lot_code, sticker_code, display_code, warehouse_id, auction_id, photo_urls,
             intake_bin_id,
             intake_bin:bins!lots_intake_bin_id_fkey(code),
             auctions(id, pickup_mode_override, pickup_starts_at, pickup_ends_at),
             warehouses(
               id, name, address_line1, address_line2, city, state, postal_code, timezone,
               floor_plan_url, floor_plan_width_px, floor_plan_height_px,
               entrance_x_px, entrance_y_px,
               pickup_mode, pickup_hours, pickup_slot_capacity
             )
           )
         )`,
      )
      .eq('id', id)
      .single();

    const inv = invoice as unknown as {
      // The auction the customer won in (invoices.auction_id, one FK). Its
      // window survives a relist; the lot's current auction does not.
      auctions: { pickup_starts_at: string | null; pickup_ends_at: string | null } | null;
      invoice_lots: Array<{
        lot_id: string;
        // 0217: per-lot handover stamp — NULL while the lot is still owed.
        picked_up_at: string | null;
        // 0245: per-lot refund stamp — a refunded lot is no longer owed.
        refunded_at: string | null;
        // 0166: stamped by the no-show sweep when the line is forfeited.
        forfeited_at: string | null;
        lots: {
          id: string;
          title: string;
          lot_code: string | null;
          sticker_code: string | null;
          warehouse_id: string;
          auction_id: string | null;
          photo_urls: string[] | null;
          intake_bin_id: string | null;
          // PostgREST returns an embedded to-one as an object (or null). The
          // bins!fkey hint disambiguates the lots→bins relationship.
          intake_bin: { code: string | null } | null;
          auctions: { id: string; pickup_mode_override: PickupMode | null; pickup_starts_at: string | null; pickup_ends_at: string | null } | null;
          warehouses: {
            id: string;
            name: string | null;
            address_line1: string | null;
            address_line2: string | null;
            city: string | null;
            state: string | null;
            postal_code: string | null;
            timezone: string | null;
            floor_plan_url: string | null;
            floor_plan_width_px: number | null;
            floor_plan_height_px: number | null;
            entrance_x_px: number | null;
            entrance_y_px: number | null;
            pickup_mode: PickupMode | null;
            // 1b (live-test C1/C2): the warehouse's appointment schedule. An
            // empty object {} (the column default) means the operator runs no
            // appointment slots — walk-in only — so the scheduler is hidden.
            pickup_hours: Record<string, unknown> | null;
            pickup_slot_capacity: number | null;
          } | null;
        } | null;
      }>;
    } | null;

    if (!inv) {
      setLoading(false);
      return;
    }

    // 0245: refunded line items are no longer owed — hide them from the
    // customer's list entirely (they were confusing next to real pickups).
    inv.invoice_lots = inv.invoice_lots.filter((il) => il.refunded_at == null);

    const firstLot = inv.invoice_lots[0]?.lots;
    const wh = firstLot?.warehouses ?? null;
    const auction = firstLot?.auctions ?? null;
    // Invoice's auction first: a relist takes the lot off its auction and
    // the window went blank (2026-10-21, invoice d684ead9).
    const pickupWindow = pickupWindowFor(inv.auctions, auction);
    setPickupWindowStart(pickupWindow.pickup_starts_at);
    setPickupWindowEnd(pickupWindow.pickup_ends_at);

    if (wh) {
      const mode = (wh.pickup_mode ?? 'staff_assisted') as PickupMode;
      const override = (auction?.pickup_mode_override ?? null) as PickupMode | null;
      // Hybrid: use the auction's override to pick the concrete mode.
      // If mode is hybrid but override is also null/hybrid, fall back to
      // counter_pickup (most common real-world config).
      let effective: PickupMode = override ?? mode;
      if (effective === 'hybrid') {
        effective = 'counter_pickup';
      }
      // Legacy 'self_serve' rows not yet migrated by 0165 → treat as counter_pickup
      // (Harrison had no floor plan so it would have mapped here anyway).
      if ((effective as string) === 'self_serve') {
        effective = 'counter_pickup';
      }

      setWarehouse({
        id: wh.id,
        name: wh.name,
        address_line1: wh.address_line1,
        address_line2: wh.address_line2,
        city: wh.city,
        state: wh.state,
        postal_code: wh.postal_code,
        timezone: wh.timezone,
        floorPlanUrl: wh.floor_plan_url,
        width: wh.floor_plan_width_px,
        height: wh.floor_plan_height_px,
        entranceX: wh.entrance_x_px,
        entranceY: wh.entrance_y_px,
        pickupMode: mode,
      });
      setEffectiveMode(effective as 'counter_pickup' | 'staff_assisted' | 'self_serve_floor_plan');

      // 1b (live-test C1/C2): the operator runs appointment slots only when
      // pickup_hours is a non-empty object. The column defaults to {} (no
      // schedule → continuous/walk-in), so an empty or null value hides the
      // scheduler in staff_assisted mode.
      const hours = wh.pickup_hours;
      setRunsAppointments(
        !!hours && typeof hours === 'object' && Object.keys(hours).length > 0,
      );

      // 0094: retired_at IS NULL is the canonical active filter. The old
      // `is_active = true` was unenforced and ambiguous.
      const { data: binRows } = await supabase
        .from('bins')
        .select('id, code, aisle, x_px, y_px, landmark_photo_url')
        .eq('warehouse_id', wh.id)
        .is('retired_at', null);
      setAllBins(
        (binRows ?? []) as Array<{
          id: string;
          code: string;
          aisle: string;
          x_px: number;
          y_px: number;
          landmark_photo_url: string | null;
        }>,
      );
    }

    const lotIds = inv.invoice_lots.map((il) => il.lot_id);
    // 0217: lots the operator has already handed over (partial pickups).
    const pickedLotIds = new Set(
      inv.invoice_lots.filter((il) => il.picked_up_at != null).map((il) => il.lot_id),
    );
    // Cache title + first lot photo so the row renderer can fall back to
    // the listing photo when no staging photo exists yet (mid-prep state
    // — bidder report 2026-06-01 "no thumbnails in pickup list").
    const lotMeta = new Map<
      string,
      {
        title: string;
        displayCode: string | null;
        firstPhoto: string | null;
        storageBinCode: string | null;
      }
    >(
      inv.invoice_lots.map((il) => [
        il.lot_id,
        {
          title: il.lots?.title ?? 'Lot',
          // Same human-facing code the browser shows (sticker label → lot_code).
          displayCode: il.lots ? lotDisplayCode(il.lots) : null,
          firstPhoto: il.lots?.photo_urls?.[0] ?? null,
          // H3: the lot's actual physical shelf from put-away/intake. Used as
          // the location fallback when no staging row exists (counter_pickup /
          // self_serve, where staff never stage).
          storageBinCode: il.lots?.intake_bin?.code ?? null,
        },
      ]),
    );

    let assignments: Array<{
      lot_id: string;
      bin_id: string;
      status: string;
      staging_photo_url: string | null;
      bins: { code: string } | null;
    }> = [];
    if (lotIds.length) {
      const { data } = await supabase
        .from('bin_assignments')
        .select('lot_id, bin_id, status, staging_photo_url, assigned_at, bins(code)')
        .in('lot_id', lotIds)
        .order('assigned_at', { ascending: false });
      assignments = (data ?? []) as unknown as typeof assignments;
    }
    const latestByLot = new Map<string, (typeof assignments)[number]>();
    for (const a of assignments) if (!latestByLot.has(a.lot_id)) latestByLot.set(a.lot_id, a);

    const merged: LotWithAssignment[] = lotIds.map((lotId) => {
      const a = latestByLot.get(lotId);
      const meta = lotMeta.get(lotId);
      // Staging photo wins (taken by staff at the moment of staging,
      // so it's the most "this is your actual item" reassurance).
      // Fall back to the lot's first listing photo so a "preparing"
      // row still shows what the bidder bought.
      const photo = a?.staging_photo_url ?? meta?.firstPhoto ?? null;
      return {
        lot_id: lotId,
        title: meta?.title ?? 'Lot',
        displayCode: meta?.displayCode ?? null,
        bin_id: a?.bin_id ?? null,
        // H3: prefer the staging bin (set at checkout); fall back to the
        // put-away/intake bin so counter_pickup / self_serve lots still show
        // a shelf location instead of "Coming soon".
        bin_code: a?.bins?.code ?? meta?.storageBinCode ?? null,
        // 0217: the invoice_lots stamp wins — it covers never-staged
        // (manual-checkout) lots that have no bin_assignment to flip.
        status: pickedLotIds.has(lotId)
          ? 'picked_up'
          : !a
            ? 'unstaged'
            : a.status === 'picked_up'
              ? 'picked_up'
              : 'staged',
        staging_photo_url: photo,
        invoice_id: id!,
      };
    });

    // Pickup row state (status + appointment + QR token + completion time).
    const { data: pickupRow } = await supabase
      .from('pickups')
      .select('status, scheduled_at, bidder_check_in_token, pickup_mode, completed_at')
      .eq('invoice_id', id)
      .maybeSingle();
    setScheduledAt(((pickupRow?.scheduled_at as string | null) ?? null) || null);
    setCheckInToken(
      (pickupRow as { bidder_check_in_token?: string } | null)?.bidder_check_in_token ?? null,
    );
    setPickupStatus((pickupRow?.status as string | null) ?? null);
    setForfeited(
      isPickupForfeited(
        (pickupRow?.status as string | null) ?? null,
        inv.invoice_lots.filter((il) => il.picked_up_at == null),
      ),
    );
    setCompletedAt((pickupRow as { completed_at?: string | null } | null)?.completed_at ?? null);

    // Fetch operator refund window so the bidder knows the return policy
    // before arriving at the warehouse.
    const { data: invoiceMeta } = await supabase
      .from('invoices')
      .select('operator_id')
      .eq('id', id)
      .single();
    const operatorId = (invoiceMeta as { operator_id?: string } | null)?.operator_id ?? null;
    if (operatorId) {
      // PR-B (mig 0157): pull the full policy shape so the no-show banner +
      // restock-fee disclosure can render. Select latest published version.
      const { data: pol } = await supabase
        .from('operator_policies')
        .select(
          'refund_window_post_pickup_hours, allow_bidder_disputes, no_show_policy, restock_fee_cents, relist_fee_cents, admin_can_refund_outside_window',
        )
        .eq('operator_id', operatorId)
        .eq('published', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      setPolicy(
        (pol as unknown as OperatorPolicyMinimal | null) ?? DEFAULT_OPERATOR_POLICY,
      );

      // G4: operator's free-form pickup hours display text (mig 0113).
      const { data: opRow } = await supabase
        .from('operators')
        .select('pickup_hours_text')
        .eq('id', operatorId)
        .maybeSingle();
      setPickupHoursText(
        (opRow as { pickup_hours_text?: string | null } | null)?.pickup_hours_text ?? null,
      );
    } else {
      setPolicy(DEFAULT_OPERATOR_POLICY);
    }

    setLots(merged);
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime subscription on bin_assignments — when picker stages or scans,
  // we refetch so the map highlights the new bin.
  const lotIdsRef = useMemo(() => ({ current: new Set(lots.map((l) => l.lot_id)) }), [lots]);
  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`pickup:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bin_assignments' },
        (payload) => {
          const lotId =
            (payload.new as { lot_id?: string } | null)?.lot_id ??
            (payload.old as { lot_id?: string } | null)?.lot_id;
          if (lotId && lotIdsRef.current.has(lotId)) load();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, load]);

  // pickup_started: fires once per mount on the first load that knows
  // the warehouse mode. pickup_completed: fires once when either (a)
  // the bidder_confirm RPC succeeds (handled in onConfirmCustomerPickup
  // below) OR (b) Realtime flips every assignment to `picked_up`
  // (staff-assisted: operator marks delivered at counter).
  useEffect(() => {
    if (loading) return;
    if (!id) return;
    if (!pickupStartedFiredRef.current) {
      pickupStartedFiredRef.current = true;
      capturePickupStarted({ invoice_id: id, mode: effectiveMode });
    }
    if (
      lots.length > 0 &&
      lots.every((l) => l.status === 'picked_up') &&
      !pickupCompletedFiredRef.current
    ) {
      pickupCompletedFiredRef.current = true;
      capturePickupCompleted({
        invoice_id: id,
        lots_count: lots.length,
        mode: effectiveMode,
      });
    }
  }, [loading, id, lots, effectiveMode]);

  const binPins: BinPin[] = useMemo(() => {
    const myBinIds = new Set<string>();
    const pickedBinIds = new Set<string>();
    for (const l of lots) {
      if (l.bin_id) {
        myBinIds.add(l.bin_id);
        if (l.status === 'picked_up') pickedBinIds.add(l.bin_id);
      }
    }
    return allBins.map((b) => ({
      binId: b.id,
      code: b.code,
      aisle: b.aisle,
      xPx: b.x_px,
      yPx: b.y_px,
      isMine: myBinIds.has(b.id),
      pickedUp: pickedBinIds.has(b.id),
      landmarkPhotoUrl: b.landmark_photo_url,
    }));
  }, [allBins, lots]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  const stagedCount = lots.filter((l) => l.status === 'staged').length;
  const unstagedCount = lots.filter((l) => l.status === 'unstaged').length;
  const pickedCount = lots.filter((l) => l.status === 'picked_up').length;
  const allStaged = unstagedCount === 0 && stagedCount > 0;
  const allChecked = lots.length > 0 && lots.every((l) => collected[l.lot_id] || l.status === 'picked_up');
  const isCompleted = pickupStatus === 'completed';
  // PR-B (mig 0158): cron auto_mark_pickup_no_show() flips pickups.status to
  // 'no_show' once the operator's pickup_window passes. Bidder sees the
  // NoShowBanner + a forfeiture / refund-pending message; BinScanner +
  // Confirm-pickup CTA + QR are hidden.
  // 2026-10-21: 'forfeited' fell through, so a forfeited pickup still showed
  // the check-in QR and Confirm pickup. Treat it as closed the same way.
  const isNoShow = pickupStatus === 'no_show' || forfeited;

  // M6: is the dispute / "Report a problem" entry available right now?
  // The dispute flow IS the bidder's refund path (bidder reports a problem →
  // operator decides refund/deny). It should be discoverable in every pickup
  // mode (counter_pickup / self_serve lots are never staged, so the old
  // `staged || picked_up` gate hid it entirely there).
  //
  // Gate it by the operator's post-pickup refund window:
  //   - window of 0 hours  → "all sales final" → no entry.
  //   - window > 0, not yet picked up → open (you can flag an issue at pickup).
  //   - window > 0, picked up → open only until completed_at + window hours.
  // policy is the operator's published policy (DEFAULT_OPERATOR_POLICY = 48h if
  // the row failed to load — see the constant).
  const refundWindowHours = policy?.refund_window_post_pickup_hours ?? 0;
  const refundWindowOpen =
    (policy?.allow_bidder_disputes ?? true) &&
    refundWindowHours > 0 &&
    (!completedAt ||
      Date.now() <=
        new Date(completedAt).getTime() + refundWindowHours * 60 * 60 * 1000);

  async function onConfirmCustomerPickup() {
    if (!id) return;
    if (!allChecked) {
      Alert.alert('Check all items first', 'Tick each item on your list to confirm you have it.');
      return;
    }
    setConfirming(true);
    try {
      const { data, error } = await supabase.rpc('bidder_confirm_customer_pickup', {
        p_invoice_id: id,
      });
      if (error) throw error;
      const result = data as { ok?: boolean; error?: string; lots_confirmed?: number } | null;
      if (result && result.ok === false) {
        throw new Error(result.error ?? 'Confirmation failed');
      }
      // Self-serve confirm — fire pickup_completed now rather than
      // waiting for the Realtime echo, so the funnel doesn't undercount
      // if the bidder backgrounds the app immediately after tapping.
      if (!pickupCompletedFiredRef.current && id) {
        pickupCompletedFiredRef.current = true;
        capturePickupCompleted({
          invoice_id: id,
          lots_count: result?.lots_confirmed ?? lots.length,
          mode: effectiveMode,
        });
      }
      Alert.alert(
        'Pickup confirmed',
        `${result?.lots_confirmed ?? lots.length} item(s) marked as collected. Thanks!`,
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/pickup') }],
      );
    } catch (err) {
      Alert.alert('Could not confirm', (err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  // Floor-plan readiness only matters for self_serve_floor_plan mode where
  // the map IS the experience. counter_pickup and staff_assisted never show a map.
  const hasFloorPlan = !!(warehouse?.floorPlanUrl && warehouse.width && warehouse.height);

  // Shared refresh control
  const sharedRefreshControl = (
    <RefreshControl
      refreshing={refreshing}
      tintColor="#8a93a6"
      onRefresh={() => {
        setRefreshing(true);
        load();
      }}
    />
  );

  // ── COUNTER PICKUP MODE ─────────────────────────────────────────────────
  // Bidder walks aisles, finds lots on labeled shelves, brings to counter.
  // QR is prominent. Bin codes always shown. No map, no floor-plan empty-state.
  if (effectiveMode === 'counter_pickup') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ gap: 12 }}
        refreshControl={sharedRefreshControl}
      >
        <WarehouseHeader
          warehouse={warehouse}
          scheduledAt={scheduledAt}
          pickupHoursText={pickupHoursText}
          effectiveMode={effectiveMode}
          pickupWindowStart={pickupWindowStart}
          pickupWindowEnd={pickupWindowEnd}
        />

        {isNoShow && policy && (
          <View style={{ paddingHorizontal: 16 }}>
            <NoShowBanner policy={policy} invoiceTotalCents={null} />
          </View>
        )}

        {/* Hero QR — hidden when no-show'd */}
        {checkInToken && !isCompleted && !isNoShow && (
          <View
            style={{
              marginHorizontal: 16,
              padding: 20,
              backgroundColor: '#1c2e49',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#232839',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: '#8a93a6',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                marginBottom: 10,
              }}
            >
              Show this QR to staff at the counter
            </Text>
            <QRCode
              value={`bingo://pickup/${checkInToken}`}
              size={240}
              backgroundColor="#1c2e49"
              color="#e8eaf0"
            />
            <Text
              style={{
                color: '#8a93a6',
                fontSize: 12,
                marginTop: 12,
                textAlign: 'center',
                lineHeight: 18,
              }}
            >
              Collect your items from the shelves and bring them here to check out.
            </Text>
            {/* M5: clarify how checkout completes so bidders aren't left
                looking for a "confirm" button in the app. */}
            <Text
              style={{
                color: '#c8d0e0',
                fontSize: 12,
                fontWeight: '600',
                marginTop: 8,
                textAlign: 'center',
                lineHeight: 18,
              }}
            >
              Staff will scan this QR to complete your pickup — no action needed in the app.
            </Text>
          </View>
        )}

        {/* C1: counter_pickup is walk-in — no appointment time-slots. The
            PickupScheduler render was removed here per live-test feedback;
            bidders collect from shelves and check out at the counter. */}

        {!isNoShow && policy && (
          <RefundPolicyNote policy={policy} />
        )}

        {/* Lot list with bin codes always visible */}
        <LotList lots={lots} mode="counter_pickup" collected={collected} setCollected={setCollected} showReportProblem={refundWindowOpen} />
      </ScrollView>
    );
  }

  // ── STAFF-ASSISTED MODE ──────────────────────────────────────────────────
  // Staff retrieves items; bidder shows QR at counter. No bin codes shown
  // (bidder doesn't need to know shelf location — staff handles retrieval).
  if (effectiveMode === 'staff_assisted') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ gap: 12 }}
        refreshControl={sharedRefreshControl}
      >
        <WarehouseHeader
          warehouse={warehouse}
          scheduledAt={scheduledAt}
          pickupHoursText={pickupHoursText}
          effectiveMode={effectiveMode}
          pickupWindowStart={pickupWindowStart}
          pickupWindowEnd={pickupWindowEnd}
        />

        {isNoShow && policy && (
          <View style={{ paddingHorizontal: 16 }}>
            <NoShowBanner policy={policy} invoiceTotalCents={null} />
          </View>
        )}

        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>Status</Text>
          <Text style={{ color: '#e8eaf0', fontSize: 16 }}>
            {isNoShow
              ? '⨯ Pickup window closed'
              : isCompleted
                ? '✓ Pickup complete'
                : allStaged
                  ? `◉ All ${lots.length} item(s) staged and ready`
                  : `${stagedCount} of ${lots.length} item(s) staged${unstagedCount > 0 ? ` · ${unstagedCount} preparing` : ''}`}
          </Text>
        </View>

        {/* 1b (C2): only show the appointment scheduler when the operator
            actually runs booked slots (warehouses.pickup_hours non-empty).
            Otherwise staff pickup is walk-in on counter hours and the
            scheduler is hidden. */}
        {runsAppointments && (
          <View style={{ paddingHorizontal: 16 }}>
            <PickupScheduler
              invoiceId={id!}
              currentScheduledAt={scheduledAt}
              onScheduled={() => load()}
              timeZone={warehouse?.timezone ?? null}
            />
          </View>
        )}

        {/* Hero QR — hidden when no-show'd */}
        {checkInToken && !isCompleted && !isNoShow && (
          <View
            style={{
              marginHorizontal: 16,
              padding: 20,
              backgroundColor: '#1c2e49',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#232839',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: '#8a93a6',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                marginBottom: 10,
              }}
            >
              Show this QR to staff at the counter
            </Text>
            <QRCode
              value={`bingo://pickup/${checkInToken}`}
              size={220}
              backgroundColor="#1c2e49"
              color="#e8eaf0"
            />
            <Text
              style={{
                color: '#8a93a6',
                fontSize: 12,
                marginTop: 12,
                textAlign: 'center',
                lineHeight: 18,
              }}
            >
              Staff scan this to pull up your invoice and bring your items.
            </Text>
          </View>
        )}

        {!isNoShow && policy && (
          <RefundPolicyNote policy={policy} />
        )}

        {/* Backup self-scan path (rare). Hidden on no-show. */}
        {!isCompleted && !isNoShow && (
          <View style={{ paddingHorizontal: 16 }}>
            <BinScanner onConfirmed={() => load()} />
          </View>
        )}

        {/* staff_assisted: no bin codes — staff retrieves */}
        <LotList lots={lots} mode="staff_assisted" collected={collected} setCollected={setCollected} showReportProblem={refundWindowOpen} />
      </ScrollView>
    );
  }

  // ── SELF-SERVE FLOOR PLAN MODE ────────────────────────────────────────────
  // Map is the hero. Bidder walks the warehouse, checks off items, then
  // taps Confirm pickup. Requires a published floor plan.
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingBottom: 96 }}
        refreshControl={sharedRefreshControl}
      >
        <WarehouseHeader
          warehouse={warehouse}
          scheduledAt={scheduledAt}
          pickupHoursText={pickupHoursText}
          effectiveMode={effectiveMode}
          pickupWindowStart={pickupWindowStart}
          pickupWindowEnd={pickupWindowEnd}
        />

        {isNoShow && policy && (
          <View style={{ paddingHorizontal: 16 }}>
            <NoShowBanner policy={policy} invoiceTotalCents={null} />
          </View>
        )}

        <View style={{ paddingHorizontal: 16, gap: 4 }}>
          <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>
            {isNoShow ? 'Pickup window closed' : 'Your route'}
          </Text>
          <Text style={{ color: '#e8eaf0', fontSize: 16 }}>
            {isNoShow
              ? 'These items were not picked up by the deadline.'
              : `${pickedCount} of ${lots.length} collected`}
          </Text>
        </View>

        {/* Hero: floor plan map. Only renders when the operator has published
            the floor plan. The "Map not ready" empty-state is gone — bidders
            in self_serve_floor_plan mode just see the checklist until the
            operator publishes. */}
        {hasFloorPlan && warehouse?.floorPlanUrl && warehouse.width && warehouse.height ? (
          <View style={{ height: 360, backgroundColor: '#1c2e49' }}>
            <PickupMap
              floorPlanUrl={warehouse.floorPlanUrl}
              widthPx={warehouse.width}
              heightPx={warehouse.height}
              bins={binPins}
              entrance={warehouse.entranceX != null && warehouse.entranceY != null
                ? { x: warehouse.entranceX, y: warehouse.entranceY }
                : undefined}
            />
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 6 }}>
            <Text style={{ color: '#e8eaf0', fontSize: 16, fontWeight: '600' }}>
              Map coming soon
            </Text>
            <Text style={{ color: '#8a93a6', lineHeight: 20 }}>
              Your operator is finalising the warehouse map. Your items and bin locations are listed below.
            </Text>
          </View>
        )}

        {!isNoShow && policy && (
          <View style={{ paddingHorizontal: 16 }}>
            <RefundPolicyNote policy={policy} />
          </View>
        )}

        <LotList
          lots={lots}
          mode="self_serve_floor_plan"
          collected={collected}
          setCollected={setCollected}
          showReportProblem={refundWindowOpen}
        />
      </ScrollView>

      {/* Confirm-pickup CTA, sticky bottom. Hidden on no-show. */}
      {!isCompleted && !isNoShow && (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 12,
            backgroundColor: colors.bg,
            borderTopWidth: 1,
            borderTopColor: '#232839',
          }}
        >
          <Pressable
            onPress={onConfirmCustomerPickup}
            disabled={!allChecked || confirming}
            style={{
              padding: 16,
              borderRadius: 12,
              backgroundColor: allChecked && !confirming ? '#3b82f6' : '#232839',
              alignItems: 'center',
            }}
          >
            {confirming ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: allChecked ? '#fff' : '#8a93a6', fontWeight: '700' }}>
                {allChecked ? 'Confirm pickup' : `Check ${lots.length - lots.filter((l) => collected[l.lot_id] || l.status === 'picked_up').length} more to confirm`}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

const DEFAULT_PICKUP_TZ = 'America/Chicago';

function fmtPickupWindow(iso: string, tz: string | null): string {
  const zone = tz && tz.length > 0 ? tz : DEFAULT_PICKUP_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEFAULT_PICKUP_TZ,
    }).format(new Date(iso));
  }
}

function WarehouseHeader({
  warehouse,
  scheduledAt,
  pickupHoursText,
  effectiveMode,
  pickupWindowStart,
  pickupWindowEnd,
}: {
  warehouse: WarehouseInfo | null;
  scheduledAt: string | null;
  pickupHoursText: string | null;
  effectiveMode: 'counter_pickup' | 'staff_assisted' | 'self_serve_floor_plan';
  /** Auction-level pickup window start (pickup_starts_at). Display-only. */
  pickupWindowStart: string | null;
  /** Auction-level pickup window end (pickup_ends_at). Display-only. */
  pickupWindowEnd: string | null;
}) {
  if (!warehouse) return null;
  const addrLine = [warehouse.address_line1, [warehouse.city, warehouse.state].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' · ');
  // G5: Google Maps directions link — build from the full postal address.
  const addressForMaps = [
    warehouse.address_line1,
    warehouse.address_line2,
    warehouse.city,
    warehouse.state,
    warehouse.postal_code,
  ]
    .filter(Boolean)
    .join(', ');
  const mapsHref = addressForMaps
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressForMaps)}`
    : null;
  const fmt = warehouse.timezone
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: warehouse.timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  const apptLabel = scheduledAt && fmt ? fmt.format(new Date(scheduledAt)) : null;
  return (
    <View style={{ padding: 16, gap: 6, backgroundColor: '#1c2e49' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Text style={{ color: '#e8eaf0', fontSize: 18, fontWeight: '700', flex: 1 }}>
          {warehouse.name ?? 'Pickup'}
        </Text>
        {/* G5: Directions link */}
        {mapsHref && (
          <Pressable
            onPress={() => Linking.openURL(mapsHref)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#4f8cff',
              marginLeft: 8,
            }}
          >
            <Text style={{ color: '#4f8cff', fontSize: 12, fontWeight: '600' }}>
              Directions →
            </Text>
          </Pressable>
        )}
      </View>
      {addrLine ? (
        <Text style={{ color: '#8a93a6', fontSize: 13 }}>{addrLine}</Text>
      ) : null}
      {/* G4: Pickup hours text */}
      {pickupHoursText ? (
        <Text style={{ color: '#8a93a6', fontSize: 13 }}>{pickupHoursText}</Text>
      ) : null}
      {/* 1c (C1): counter_pickup is walk-in — never surface an "Appointment:"
          line even if a stale scheduled_at is on the pickup row. */}
      {apptLabel && effectiveMode !== 'counter_pickup' ? (
        <Text style={{ color: '#8a93a6', fontSize: 13 }}>Appointment: {apptLabel}</Text>
      ) : null}
      {/* Pickup window — shows the auction-level opens/closes times in the
          warehouse's local time. Display-only; does not affect any gate. */}
      {(pickupWindowStart || pickupWindowEnd) ? (
        <View style={{ marginTop: 6, gap: 2 }}>
          <Text
            style={{
              color: '#8a93a6',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.8,
            }}
          >
            Pickup window
          </Text>
          {pickupWindowStart ? (
            <Text style={{ color: '#e8eaf0', fontSize: 13 }}>
              Opens {fmtPickupWindow(pickupWindowStart, warehouse?.timezone ?? null)}
            </Text>
          ) : null}
          {pickupWindowEnd ? (
            <Text style={{ color: '#e8eaf0', fontSize: 13 }}>
              Closes {fmtPickupWindow(pickupWindowEnd, warehouse?.timezone ?? null)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function LotList({
  lots,
  mode,
  collected,
  setCollected,
  showReportProblem,
}: {
  lots: LotWithAssignment[];
  mode: 'counter_pickup' | 'staff_assisted' | 'self_serve_floor_plan';
  collected: Record<string, boolean>;
  setCollected: (next: Record<string, boolean>) => void;
  // M6: whether the "Report a problem" (dispute/refund) entry is shown. Driven
  // by the operator's post-pickup refund window — see refundWindowOpen.
  showReportProblem: boolean;
}) {
  // counter_pickup and self_serve_floor_plan both let bidders check off items.
  // staff_assisted: staff retrieves, so checkboxes add noise.
  const showCheckboxes = mode === 'counter_pickup' || mode === 'self_serve_floor_plan';
  // PICKUP-LOC-1: the shelf location is now shown in ALL modes whenever
  // bin_code is present, matching the web pickup page (web showed it
  // unconditionally; the app used to hide it in staff_assisted). The FRAMING
  // is mode-aware in the render below — counter_pickup / self_serve_floor_plan
  // say "On shelf" (self-collect), staff_assisted says "Stored at"
  // (informational; staff retrieve). When bin_code is null in staff_assisted
  // we keep the existing 'Ready for pickup' / 'Coming soon' staging copy.
  // selfCollect = the bidder physically retrieves the item (governs framing).
  const selfCollect = mode === 'counter_pickup' || mode === 'self_serve_floor_plan';

  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginBottom: 6 }}>
        Your items ({lots.length})
      </Text>
      {/* 0217: partial-pickup progress — only shown mid-way (some picked,
          some owed) so the normal single-trip flow stays uncluttered. */}
      {(() => {
        const picked = lots.filter((l) => l.status === 'picked_up').length;
        if (picked === 0 || picked >= lots.length) return null;
        return (
          <View
            style={{
              backgroundColor: 'rgba(246,145,30,0.12)',
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              marginBottom: 8,
            }}
          >
            <Text style={{ color: '#f6911e', fontSize: 12, fontWeight: '700' }}>
              {picked} of {lots.length} picked up — the rest are still yours to collect.
              Show the same QR code when you come back.
            </Text>
          </View>
        );
      })()}
      {lots.map((l) => {
        const isPicked = l.status === 'picked_up';
        const isChecked = isPicked || !!collected[l.lot_id];
        return (
          <View
            key={l.lot_id}
            style={{
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: '#232839',
              flexDirection: 'row',
              gap: 12,
              alignItems: 'center',
            }}
          >
            {showCheckboxes && (
              <Pressable
                onPress={() => {
                  if (isPicked) return; // already final
                  setCollected({ ...collected, [l.lot_id]: !collected[l.lot_id] });
                }}
                disabled={isPicked}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: isChecked ? '#3b82f6' : '#3a4257',
                  backgroundColor: isChecked ? '#3b82f6' : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isChecked && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
              </Pressable>
            )}
            {/* Tap the photo to open the original lot listing (photos +
                description) so the bidder can verify the item before pickup
                (feature request 2026-07-17). */}
            <Link href={`/lot/${l.lot_id}`} asChild>
              <Pressable>
                {l.staging_photo_url ? (
                  <Image
                    source={{ uri: l.staging_photo_url }}
                    style={{ width: 56, height: 56, borderRadius: 6, backgroundColor: '#1c2e49' }}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 6,
                      backgroundColor: '#1c2e49',
                      borderWidth: 1,
                      borderColor: '#232839',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: '#8a93a6', fontSize: 10 }}>no photo</Text>
                  </View>
                )}
              </Pressable>
            </Link>
            <View style={{ flex: 1, justifyContent: 'space-between' }}>
              {/* Lot code next to the title — the same human-facing code the
                  browser shows (sticker label → lot_code). Monospace accent
                  style to match the web pickup page. */}
              {l.displayCode ? (
                <Text
                  style={{
                    color: '#4f8cff',
                    fontSize: 11,
                    fontWeight: '700',
                    fontFamily: 'monospace',
                    letterSpacing: 0.4,
                    marginBottom: 2,
                  }}
                >
                  {l.displayCode}
                </Text>
              ) : null}
              <Text style={{ color: '#e8eaf0' }}>{l.title}</Text>
              <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
                {/* PICKUP-LOC-1 / H3: location copy is mode-aware. The shelf
                    location is now shown in ALL modes when bin_code is known.
                    - picked_up → confirmation (+ bin code).
                    - self-collect (counter_pickup / self_serve_floor_plan):
                      show the shelf ("On shelf · {bin}") AS SOON AS we know it,
                      even before staff stage, so the bidder can go collect it.
                      Fall back to the floor-find message if no shelf is known.
                    - staff_assisted: bidder never collects, so frame the shelf
                      as informational ("Stored at · {bin}"). When no shelf is
                      known yet, keep the staging copy — "Ready for pickup" once
                      staged, "Coming soon" while staff are still preparing. */}
                {isPicked
                  ? `✓ Picked up${l.bin_code ? ` · ${l.bin_code}` : ''}`
                  : selfCollect
                    ? l.bin_code
                      ? `On shelf · ${l.bin_code}`
                      : 'Find it on the floor — ask staff if unsure'
                    : l.bin_code
                      ? `Stored at · ${l.bin_code}`
                      : l.status === 'staged'
                        ? 'Ready for pickup'
                        : 'Coming soon'}
              </Text>
              {/* Open the original listing (photos + description) — helps the
                  bidder confirm the item before coming in (2026-07-17). */}
              <Link href={`/lot/${l.lot_id}`} asChild>
                <Pressable hitSlop={6}>
                  <Text style={{ color: '#4f8cff', fontSize: 12, marginTop: 4 }}>
                    {'View listing & photos →'}
                  </Text>
                </Pressable>
              </Link>
              {/* M6: shown whenever the operator's refund window is open, in
                  ALL pickup modes (the old `staged || picked_up` gate never
                  fired in counter_pickup / self_serve, where lots aren't
                  staged). Routes to the dispute flow = the bidder's refund
                  request; the operator decides the outcome. */}
              {showReportProblem && (
                <Link
                  href={{
                    pathname: '/dispute/new',
                    params: { lotId: l.lot_id, invoiceId: l.invoice_id },
                  }}
                  asChild
                >
                  <Pressable>
                    <Text style={{ color: '#ff5470', fontSize: 12, marginTop: 4 }}>
                      Report a problem
                    </Text>
                  </Pressable>
                </Link>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── RefundPolicyNote ────────────────────────────────────────────────────────
// Displays the operator's post-pickup refund window so the bidder knows
// the return terms before arriving at the warehouse.
// PR-B (mig 0157): takes the full policy so it can also surface a restock-fee
// disclosure when no_show_policy=refund_minus_restock AND restock_fee_cents>0.
// refund_window_post_pickup_hours === 0 → all sales final after pickup.
// refund_window_post_pickup_hours  > 0  → N-hour return window.

function RefundPolicyNote({ policy }: { policy: OperatorPolicyMinimal }) {
  const hours = policy.refund_window_post_pickup_hours;
  const isFinal = hours === 0;
  const showRestock =
    !isFinal &&
    policy.no_show_policy === 'refund_minus_restock' &&
    policy.restock_fee_cents > 0;
  return (
    <View
      style={{
        marginVertical: 8,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        backgroundColor: isFinal ? 'rgba(248, 113, 113, 0.07)' : 'rgba(79, 140, 255, 0.07)',
        borderColor: isFinal ? '#f87171' : '#4f8cff',
      }}
    >
      <Text
        style={{
          color: isFinal ? '#f87171' : '#4f8cff',
          fontSize: 13,
          fontWeight: '600',
          lineHeight: 18,
        }}
      >
        {isFinal
          ? 'All sales final after pickup per auctioneer policy.'
          : `${hours}-hour return window after pickup per auctioneer policy.`}
      </Text>
      {showRestock && (
        <Text
          style={{
            color: '#8a93a6',
            fontSize: 12,
            marginTop: 4,
            lineHeight: 16,
          }}
        >
          {`Restock fee ${formatPolicyCents(policy.restock_fee_cents)} may apply to returns.`}
        </Text>
      )}
    </View>
  );
}

// ── NoShowBanner ────────────────────────────────────────────────────────────
// Shown when pickups.status === 'no_show' (flipped by mig 0158's cron). The
// copy branches on the operator's no_show_policy:
//   full_forfeit          → "lots forfeited, no refund" (BidFTA-style default)
//   refund_minus_restock  → "refund pending minus restock fee"
// invoiceTotalCents is optional; when null we omit the dollar amount and
// just say "refund is being processed".

function NoShowBanner({
  policy,
  invoiceTotalCents,
}: {
  policy: OperatorPolicyMinimal;
  invoiceTotalCents: number | null;
}) {
  const isForfeit = policy.no_show_policy === 'full_forfeit';
  const restockCents = policy.restock_fee_cents;
  const refundCents =
    invoiceTotalCents != null ? Math.max(0, invoiceTotalCents - restockCents) : null;
  return (
    <View
      testID="pickup-no-show-banner"
      style={{
        marginVertical: 8,
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        backgroundColor: 'rgba(248, 113, 113, 0.10)',
        borderColor: '#f87171',
        gap: 6,
      }}
    >
      <Text style={{ color: '#f87171', fontWeight: '800', fontSize: 15 }}>
        Pickup window closed
      </Text>
      <Text style={{ color: '#e8eaf0', fontSize: 13, lineHeight: 19 }}>
        {isForfeit
          ? 'These lots were not picked up by the deadline and have been forfeited per the auctioneer’s policy.'
          : refundCents != null
            ? `A refund of ${formatPolicyCents(refundCents)} is being processed (restock fee ${formatPolicyCents(restockCents)} withheld). Expect 5–10 business days to your card on file.`
            : `Your refund (minus a restock fee of ${formatPolicyCents(restockCents)}) is being processed. Expect 5–10 business days to your card on file.`}
      </Text>
    </View>
  );
}

// Tiny private formatter so we don't have to thread the shared one through.
function formatPolicyCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)}`;
}
