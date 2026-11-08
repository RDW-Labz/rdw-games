// Pickup sessions (mig 0241) — one QR per customer visit + aisle-ordered
// walk list. Shared by the bidder "Pickup pass" page, the bidder progress
// API, and the staff counter page.
//
// Membership is COMPUTED, never stored: a session covers every pickup of
// the bidder whose status is still pending/scheduled at read time. Paying
// an invoice a minute before the counter scan adds it automatically.

import { lotDisplayCode, type LotCodeFields } from '@auction-platform/shared';

import { getSupabaseAdmin } from '@/lib/supabase-admin';

export type SessionItem = {
  lotId: string;
  lotCode: string;
  stickerCode: string | null;
  /**
   * What the customer and the counter should READ — the label physically on the
   * box. Resolved once here (sticker, else the relist lineage's label, else
   * lot_code) so the pass and the staff list can never disagree.
   */
  displayCode: string;
  title: string;
  photoUrl: string | null;
  invoiceId: string;
  /** The invoice's pickup row — outcome writes key on (pickup_id, lot_id). */
  pickupId: string;
  /** Staff-recorded outcome (mig 0243). null = undecided (treated as
   *  collected at completion). 'collected'/'missing' drop the item from the
   *  bidder's walk list; 'left_behind' keeps it for the return trip. */
  outcome: 'collected' | 'missing' | 'left_behind' | null;
  /** Bin the lot is staged in (bin_assignments 'staged', else intake bin). */
  binCode: string | null;
  /** 0293: which building this item is in. Aisle numbers repeat across
   *  warehouses, so a walk list without this is ambiguous. */
  warehouseId: string | null;
  warehouseName: string | null;
  aisle: string | null;
  bay: string | null;
  /** Pickup deadline for this item's invoice (auction pickup_ends_at +
   *  membership extended-pickup days). Customer feedback 2026-07-09: the
   *  date must sit ON each item — sorting alone shifts as the list changes. */
  pickupBy: string | null;
};

export type SessionInvoice = {
  id: string;
  totalCents: number;
  status: string;
  auctionTitle: string | null;
  pickupId: string;
  pickupStatus: string;
  lotCount: number;
  pickupBy: string | null;
};

export async function isPickupSessionsEnabled(): Promise<boolean> {
  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin
      .from('platform_settings')
      .select('pickup_sessions_enabled')
      .eq('id', true)
      .maybeSingle();
    return Boolean((data as { pickup_sessions_enabled?: boolean } | null)?.pickup_sessions_enabled);
  } catch {
    return false; // fail CLOSED — feature stays invisible on any error
  }
}

/** The bidder's open session, creating one if needed (unique partial index
 *  collapses a create race back to the single open row). */
export async function getOrCreateOpenSession(
  bidderId: string,
  /** 0293: scope the session to one building. Omit for the legacy
   *  all-locations session (what every pre-0293 row is). */
  warehouseId?: string | null,
): Promise<{ id: string; token: string; collectedLotIds: string[] } | null> {
  const admin = getSupabaseAdmin();
  const wh = warehouseId ?? null;
  const load = async () => {
    let q = admin
      .from('pickup_sessions')
      .select('id, token, collected_lot_ids')
      .eq('bidder_id', bidderId)
      .eq('status', 'open');
    // `.is` for NULL vs `.eq` for a value — PostgREST will not match NULL with eq.
    q = wh === null ? q.is('warehouse_id', null) : q.eq('warehouse_id', wh);
    const { data } = await q.maybeSingle();
    return data as { id: string; token: string; collected_lot_ids: string[] } | null;
  };

  let row = await load();
  if (!row) {
    const { error } = await admin
      .from('pickup_sessions')
      .insert({ bidder_id: bidderId, warehouse_id: wh });
    // 23505 = concurrent create hit the one-open-per-(bidder,warehouse) index.
    if (error && error.code !== '23505') {
      console.error('[pickup-session] create failed:', error.message);
      return null;
    }
    row = await load();
    // A swallowed 23505 is only benign when the reload then FINDS the row the
    // racing request created. If it doesn't, some OTHER unique index rejected
    // the insert and we are about to return null, which the pass renders as
    // "Couldn't start a pickup session" with nothing in the logs to explain it.
    //
    // That is exactly how the 2026-07-29 outage hid: the stale pre-0293
    // pickup_sessions_one_open_idx (UNIQUE on bidder_id alone) rejected every
    // warehouse-scoped insert for any bidder who already held a legacy
    // NULL-warehouse session, and the failure looked like a benign race. 0297
    // drops that index; this log makes the next one visible on the first
    // occurrence instead of after a field report.
    if (error?.code === '23505' && !row) {
      console.error(
        '[pickup-session] insert hit 23505 but no open session for bidder',
        bidderId,
        'warehouse',
        wh,
        '— a unique index other than the (bidder, warehouse) one is rejecting this.',
      );
    }
  }
  if (!row) return null;
  return { id: row.id, token: row.token, collectedLotIds: row.collected_lot_ids ?? [] };
}

/**
 * 0293: which buildings does this bidder actually have to visit?
 *
 * The pass used to merge every pending pickup regardless of location and
 * serpentine-order the walk by AISLE ALONE — so a bidder who won at both
 * Harrison (AR) and Dodge City (KS) got one route interleaving "Aisle 3" in two
 * buildings ~400 miles apart, behind a single QR that opened everything at
 * either counter. Callers use this to pick ONE location per pass.
 */
export async function listPickupWarehouses(
  bidderId: string,
): Promise<Array<{ id: string; name: string; lotCount: number }>> {
  const { items } = await loadSessionContents(bidderId);
  const byWarehouse = new Map<string, { id: string; name: string; lotCount: number }>();
  for (const item of items) {
    if (!item.warehouseId) continue;
    const hit = byWarehouse.get(item.warehouseId);
    if (hit) hit.lotCount += 1;
    else
      byWarehouse.set(item.warehouseId, {
        id: item.warehouseId,
        name: item.warehouseName ?? 'Warehouse',
        lotCount: 1,
      });
  }
  return Array.from(byWarehouse.values()).sort((a, b) => b.lotCount - a.lotCount);
}

/** Everything the bidder can pick up right now: eligible invoices (with
 *  their pickups) + every lot with its staged bin location. */
export async function loadSessionContents(
  bidderId: string,
  /** 0293: restrict to one building. Omit = every location (legacy behaviour). */
  warehouseId?: string | null,
): Promise<{
  invoices: SessionInvoice[];
  items: SessionItem[];
}> {
  const admin = getSupabaseAdmin();

  const { data: pickupRows, error: pickupErr } = await admin
    .from('pickups')
    // NOTE: do NOT select pickups.extended_pickup_days — that column does not
    // exist on BinGo prod (mig 0182 added the membership extended-pickup term
    // to the no-show cron but never ran the ALTER TABLE that would create the
    // column; the generated types declare it, so tsc passed while PostgREST
    // 400'd at runtime). Selecting it made this query throw for EVERY bidder,
    // which surfaced as the red "couldn't load your pickup pass" error on the
    // whole /profile/pickup-pass page (2026-07-15 field report). The displayed
    // pickup deadline uses the auction window with no membership extension (see
    // pickupByInvoice below), which matches reality since nothing populates the
    // column anyway.
    .select(
      'id, status, invoice_id, invoices!inner(id, bidder_id, total_cents, status, auctions(title, pickup_ends_at))',
    )
    // 'checked_in' = a partial pickup in flight (mig 0217) — remaining lots
    // stay owed and must keep appearing on the pass.
    // 'no_show' added 2026-07-11 (build-13 recap): a PAID bidder who missed
    // their first pickup window still owns their un-picked-up lots. Excluding
    // no_show showed them a blank "Browse Auctions" pass while their invoice
    // still listed the items. The lot-level owed filter below (picked_up_at /
    // refunded_at NULL) is what actually decides whether anything remains, so
    // including no_show here can't resurrect an already-collected item.
    .in('status', ['pending', 'scheduled', 'checked_in', 'no_show'])
    // Mirror the staff scan (0245): a fully refunded invoice owes nothing —
    // without this the pass kept showing refunded items (Jared 2026-07-07).
    // partially_refunded stays: its un-refunded lots are still owed.
    .in('invoices.status', ['paid', 'partially_refunded'])
    .eq('invoices.bidder_id', bidderId);
  if (pickupErr) {
    // Surface the failure instead of silently returning empty. Before this a
    // transient query error rendered the bidder a false "nothing to pick up"
    // (build-13 recap 2026-07-11). The page catches this and shows a
    // try-again message; the log line captures the exact DB error.
    console.error('[pickup-session] loadSessionContents pickups query failed:', pickupErr.message);
    throw new Error(`pickup_contents_load_failed: ${pickupErr.message}`);
  }

  type PickupRow = {
    id: string;
    status: string;
    invoice_id: string;
    invoices: {
      id: string;
      total_cents: number;
      status: string;
      auctions: { title: string | null; pickup_ends_at: string | null } | null;
    };
  };
  const pickups = ((pickupRows ?? []) as unknown as PickupRow[]).filter((p) => p.invoices);
  if (pickups.length === 0) return { invoices: [], items: [] };

  const invoiceIds = pickups.map((p) => p.invoice_id);

  const { data: lotRows, error: lotErr } = await admin
    .from('invoice_lots')
    .select(
      `invoice_id, picked_up_at,
       lots!inner(id, lot_code, sticker_code, display_code, title, photo_urls, status, warehouse_id,
         warehouse:warehouses(name),
         intake_bin:bins!lots_intake_bin_id_fkey(code, aisle, bay),
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code)))`,
    )
    .in('invoice_id', invoiceIds)
    // Lots handed over in a prior partial round (invoice_lots.picked_up_at,
    // mig 0217) are done — only still-owed lots belong on the pass.
    .is('picked_up_at', null)
    // Per-item refunds (invoice_lots.refunded_at, mig 0245) are done too.
    .is('refunded_at', null);
  // 0293: caller asked for ONE building. Applied after the query (rather than as
  // a .eq on the embedded lots row) because PostgREST filters on an embedded
  // table would drop the parent invoice_lots row entirely, and we still want the
  // invoice list to reflect what exists.
  if (lotErr) {
    // CRITICAL query: this decides which lots are still owed. A silent []
    // here rendered the bidder a false "nothing to pick up" even though the
    // pickups query above found their invoices — the same blank-pass class
    // as build-13 (2026-07-11), which only got fixed for the pickups query.
    // Throw so the page's retry-once + try-again banner handles it instead
    // of showing an empty pass. (2026-07-14 field report.)
    console.error(
      '[pickup-session] loadSessionContents invoice_lots query failed:',
      lotErr.message,
    );
    throw new Error(`pickup_contents_load_failed: ${lotErr.message}`);
  }

  type LotRow = {
    invoice_id: string;
    lots: {
      id: string;
      lot_code: string;
      sticker_code: string | null;
      display_code: string | null;
      title: string;
      photo_urls: string[] | null;
      warehouse_id: string | null;
      warehouse: { name: string } | Array<{ name: string }> | null;
      intake_bin: { code: string | null; aisle: string | null; bay: string | null } | null;
      relisted_from: LotCodeFields | null;
    };
  };
  const lots = ((lotRows ?? []) as unknown as LotRow[]).filter((r) => r.lots);

  // Prefer the ACTIVE staged bin assignment over the intake bin — staff may
  // re-stage a won lot closer to the counter. Read the LATEST assignment per
  // lot (like the staff verify screen does): a latest status of 'picked_up'
  // means the item physically left even if invoice_lots.picked_up_at was
  // never stamped (legacy/manual bin ops) — drop it from the pass.
  const lotIds = lots.map((r) => r.lots.id);
  const { data: assignmentRows, error: assignErr } = await admin
    .from('bin_assignments')
    .select('lot_id, status, assigned_at, bins(code, aisle, bay)')
    .in('lot_id', lotIds)
    .in('status', ['staged', 'picked_up'])
    .order('assigned_at', { ascending: false });
  // Enrichment only (staged-bin location + a legacy picked-up signal). On
  // error, degrade — show the items with their intake-bin fallback — rather
  // than blanking the pass. Log so it's not silent.
  if (assignErr) {
    console.warn(
      '[pickup-session] bin_assignments query failed (degrading to intake bin):',
      assignErr.message,
    );
  }
  const stagedByLot = new Map<
    string,
    { code: string | null; aisle: string | null; bay: string | null }
  >();
  const pickedUpLotIds = new Set<string>();
  const seenAssignment = new Set<string>();
  for (const r of (assignmentRows ?? []) as unknown as Array<{
    lot_id: string;
    status: string;
    bins: { code: string | null; aisle: string | null; bay: string | null } | null;
  }>) {
    if (seenAssignment.has(r.lot_id)) continue; // rows are newest-first
    seenAssignment.add(r.lot_id);
    if (r.status === 'picked_up') pickedUpLotIds.add(r.lot_id);
    else if (r.bins) stagedByLot.set(r.lot_id, r.bins);
  }
  const owedLots = lots
    .filter((r) => !pickedUpLotIds.has(r.lots.id))
    // 0293: one pass = one building.
    .filter((r) => !warehouseId || r.lots.warehouse_id === warehouseId);

  // Per-invoice pickup deadline: the auction's pickup window end plus any
  // membership extended-pickup days (0182). Shown on every item so the
  // customer always sees which wins expire first.
  const pickupByInvoice = new Map<string, string | null>(
    pickups.map((p) => {
      const base = p.invoices.auctions?.pickup_ends_at ?? null;
      if (!base) return [p.invoice_id, null];
      // Membership extended-pickup days would be added here, but the column
      // doesn't exist on prod (see the pickups select above) so the deadline is
      // just the auction's pickup window — no per-bidder extension is applied
      // anywhere today.
      const ts = Date.parse(base);
      if (!Number.isFinite(ts)) return [p.invoice_id, null];
      return [p.invoice_id, new Date(ts).toISOString()];
    }),
  );

  // Staff-recorded per-lot outcomes (mig 0243) for these pickups.
  const pickupIdByInvoice = new Map(pickups.map((p) => [p.invoice_id, p.id]));
  const { data: outcomeRows, error: outcomeErr } = await admin
    .from('pickup_lot_outcomes')
    .select('pickup_id, lot_id, outcome')
    .in(
      'pickup_id',
      pickups.map((p) => p.id),
    );
  // Enrichment only (per-lot outcome badges). Degrade on error — the items
  // still belong on the pass without their outcome tag. Log, don't blank.
  if (outcomeErr) {
    console.warn(
      '[pickup-session] pickup_lot_outcomes query failed (badges omitted):',
      outcomeErr.message,
    );
  }
  const outcomeByKey = new Map(
    ((outcomeRows ?? []) as Array<{ pickup_id: string; lot_id: string; outcome: string }>).map(
      (r) => [`${r.pickup_id}:${r.lot_id}`, r.outcome as 'collected' | 'missing' | 'left_behind'],
    ),
  );

  const items: SessionItem[] = owedLots.map((r) => {
    const bin = stagedByLot.get(r.lots.id) ?? r.lots.intake_bin ?? null;
    const pickupId = pickupIdByInvoice.get(r.invoice_id) ?? '';
    return {
      lotId: r.lots.id,
      lotCode: r.lots.lot_code,
      stickerCode: r.lots.sticker_code,
      displayCode:
        lotDisplayCode({
          lot_code: r.lots.lot_code,
          sticker_code: r.lots.sticker_code,
          display_code: r.lots.display_code,
          relisted_from: r.lots.relisted_from,
        }) ?? r.lots.lot_code,
      title: r.lots.title,
      photoUrl: r.lots.photo_urls?.[0] ?? null,
      invoiceId: r.invoice_id,
      pickupId,
      outcome: outcomeByKey.get(`${pickupId}:${r.lots.id}`) ?? null,
      binCode: bin?.code ?? null,
      warehouseId: r.lots.warehouse_id ?? null,
      warehouseName:
        (Array.isArray(r.lots.warehouse) ? r.lots.warehouse[0] : r.lots.warehouse)?.name ?? null,
      aisle: bin?.aisle ?? null,
      bay: bin?.bay ?? null,
      pickupBy: pickupByInvoice.get(r.invoice_id) ?? null,
    };
  });

  const lotCountByInvoice = new Map<string, number>();
  for (const item of items) {
    lotCountByInvoice.set(item.invoiceId, (lotCountByInvoice.get(item.invoiceId) ?? 0) + 1);
  }

  const invoices: SessionInvoice[] = pickups.map((p) => ({
    id: p.invoices.id,
    totalCents: p.invoices.total_cents,
    status: p.invoices.status,
    auctionTitle: p.invoices.auctions?.title ?? null,
    pickupId: p.id,
    pickupStatus: p.status,
    lotCount: lotCountByInvoice.get(p.invoice_id) ?? 0,
    pickupBy: pickupByInvoice.get(p.invoice_id) ?? null,
  }));

  return { invoices, items: serpentineOrder(items) };
}

/**
 * Serpentine walk order (Phase 2, map-free): aisles in natural order, bay
 * direction alternating per aisle — walk down aisle 1, back up aisle 2 —
 * so the path never doubles back down an aisle. Lots without a bin sort
 * last (staff finds them at the counter).
 */
export function serpentineOrder(items: SessionItem[]): SessionItem[] {
  const naturalCmp = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  // 0293: aisle labels repeat across warehouses ("Aisle 3" exists in Harrison
  // AND Dodge City), so ordering by aisle alone silently interleaves buildings.
  // Order by warehouse FIRST, then serpentine within each. A caller that scoped
  // to one warehouse gets identical output to before; an unscoped caller at
  // least gets one building at a time instead of a zig-zag between states.
  const warehouses = Array.from(new Set(items.map((i) => i.warehouseId ?? ''))).sort(naturalCmp);
  if (warehouses.length > 1) {
    return warehouses.flatMap((wid) =>
      serpentineOrder(items.filter((i) => (i.warehouseId ?? '') === wid)),
    );
  }

  const withBin = items.filter((i) => i.aisle !== null || i.binCode !== null);
  const noBin = items.filter((i) => i.aisle === null && i.binCode === null);

  const aisles = Array.from(new Set(withBin.map((i) => i.aisle ?? ''))).sort(naturalCmp);
  const aisleIndex = new Map(aisles.map((a, idx) => [a, idx]));

  const sorted = [...withBin].sort((x, y) => {
    const ax = x.aisle ?? '';
    const ay = y.aisle ?? '';
    if (ax !== ay) return naturalCmp(ax, ay);
    const reversed = (aisleIndex.get(ax) ?? 0) % 2 === 1;
    const bx = x.bay ?? x.binCode ?? '';
    const by = y.bay ?? y.binCode ?? '';
    return reversed ? naturalCmp(by, bx) : naturalCmp(bx, by);
  });

  return [...sorted, ...noBin.sort((x, y) => naturalCmp(x.lotCode, y.lotCode))];
}
