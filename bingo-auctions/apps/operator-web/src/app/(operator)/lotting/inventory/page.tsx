// Inventory — the operator's lots, split across three lifecycle buckets the
// team triages every day. A `bucket` search param drives which one is shown;
// `inventory` is the default so the page's historical behavior is preserved.
//
//   - "In auction"  (live)        → already on an auction (auction_id set,
//                                    status scheduled/live). Read-only here —
//                                    bulk assign is disabled for this bucket.
//   - "In inventory" (inventory)  → binned and ready for the Auction Builder
//                                    (status='in_inventory', no auction yet).
//                                    The default bucket and the ONLY one where
//                                    bulk "assign to auction" is enabled.
//   - "Not put away" (not_put_away) → arrived / field-lotted with a label but
//                                    not yet bin-scanned (status='pending_intake';
//                                    warehouse_id / intake_bin_id are NULL).
//
// Architectural notes:
//   - Imported manifest items NEVER appear here until binned. They live in
//     /lotting/manifest-pool until somebody scans them into a bin via the
//     picker app (migration 0059). At that moment a fully-formed lot springs
//     into existence already at status='in_inventory'.
//   - Field-lotted drafts (Quick Lot / Photo / Shelf Scan) surface in the
//     "Not put away" bucket and at /lotting/drafts until they're bin-scanned.
//
// 0068: imports() join through lots.import_id was dropped (the column no
// longer exists). Source labels now come from the denormalized lots.source
// column populated by the intake RPC.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { isWarehouseActive } from '@/lib/warehouse-active';
import { REFUNDED_STATUS, REFUNDED_TAG, showRefundedTab } from '@/lib/inventory-refunded';
import { PageHeader } from '@/components/Form';
import { FilterSelect } from '@/components/FilterSelect';
import { InventoryTable } from './InventoryTable';
import { InventoryV2 } from './v2/InventoryV2';
import type { InventoryBucket } from './v2/inventory-types';

type LotRow = {
  id: string;
  lot_code: string;
  title: string;
  status: string;
  category: string | null;
  msrp_cents: number | null;
  warehouse_id: string | null;
  intake_bin_id: string | null;
  intake_at: string | null;
  created_at: string;
  source: string | null;
  // 0154: supplier label, independent axis from source. Source = VRID /
  // Load ID / facility; vendor = supplier (Amazon, Lowe's, Wayfair).
  vendor: string | null;
  photo_urls: string[] | null;
  // 0103: legacy import support — non-null only on rows brought in via
  // bulk_import_lots() from another platform's export.
  legacy_lot_code: string | null;
  legacy_platform: string | null;
  // Issue 1 (PATCH-warehouse-lookup): surfaced so the operator can search a
  // lot by its operator-prefixed sticker code (0141) or its UPC.
  sticker_code: string | null;
  upc: string | null;
};

// Location fields resolved from intake_bin_id / warehouse_id (raw UUIDs on
// the lot) via two scoped lookups below. Attached per-lot and handed to the
// table so it can render "Warehouse · Bin (aisle/bay)".
type BinLite = { id: string; code: string; aisle: string; bay: string | null };
type WarehouseLite = { id: string; name: string };
type WarehouseTzLite = { id: string; name: string; timezone: string };
type EnrichedLotRow = LotRow & {
  warehouseName: string | null;
  binCode: string | null;
  binAisle: string | null;
  binBay: string | null;
  // IANA zone of the lot's warehouse (warehouses.timezone). Used to render
  // intake/created dates in the warehouse's wall-clock zone instead of the
  // UTC SSR runtime zone. Null when the lot has no warehouse yet (not-put-away).
  warehouseTz: string | null;
};

// Lifecycle (intake-axis) buckets PLUS sell-axis buckets (M7, live-test
// feedback 2026-06-03). Each layers its own status / auction_id / pickup
// predicate on top of the shared operator_id = me AND deleted_at IS NULL scope.
//
// Intake axis (where is it physically): live / inventory / not_put_away.
// Sell axis (M7 — what's its sell state, v1 = status-based only):
//   available    → status='in_inventory' (ready to add to an auction).
//   unsold       → status='unsold' (closed without a winning bid). Distinct
//                  from unpicked_up: pure no-bid unsold, no no-show pickup.
//   unpicked_up  → status IN ('unsold','relisted') joined to a pickup whose
//                  status IN ('no_show','forfeited'). Same forfeited-returns
//                  join the /worklist Forfeited section uses.
// v1 explicitly does NOT reference any per-bidder deadline / membership table
// (none exist in this worktree).
type Bucket =
  | 'live'
  | 'inventory'
  | 'not_put_away'
  | 'available'
  | 'unsold'
  | 'unpicked_up'
  | 'refunded';
const DEFAULT_BUCKET: Bucket = 'inventory';
const BUCKET_ORDER: Bucket[] = [
  'live',
  'inventory',
  'not_put_away',
  'available',
  'unsold',
  'unpicked_up',
  'refunded',
];
const BUCKET_LABELS: Record<Bucket, string> = {
  live: 'In auction',
  inventory: 'In inventory',
  not_put_away: 'Not put away',
  available: 'Available',
  unsold: 'Unsold',
  unpicked_up: 'Unpicked-up',
  refunded: REFUNDED_TAG,
};
const BUCKET_EMPTY_COPY: Record<Bucket, string> = {
  live: 'No lots are on an auction right now. Assign in-inventory lots from the “In inventory” tab.',
  inventory: 'No in-inventory lots yet. Pickers scan items into bins to land them here.',
  not_put_away:
    'Nothing waiting to be put away. Field-lotted and manifest items show here until a bin scan.',
  available: 'No available lots. These are in-inventory items ready to add to an auction.',
  unsold:
    'No unsold lots. Lots land here when an auction closes without a winning bid (and no no-show pickup).',
  unpicked_up:
    'No unpicked-up lots. Lots land here when a winning bidder no-shows or forfeits their pickup.',
  refunded:
    'No refunded lots waiting. A fully refunded sale lands here until a manager relists it from the lot page.',
};

// Sell-axis buckets that filter lots by a no_show/forfeited pickup via the
// invoice_lots → invoices → pickups inner-join (idiom shared with /worklist).
const PICKUP_JOIN_SELECT = 'invoice_lots!inner(invoices!inner(pickups!inner(status)))';
const PICKUP_FORFEIT_STATUSES = ['no_show', 'forfeited'];

function parseBucket(raw: string | undefined): Bucket {
  return raw === 'live' ||
    raw === 'inventory' ||
    raw === 'not_put_away' ||
    raw === 'available' ||
    raw === 'unsold' ||
    raw === 'unpicked_up' ||
    raw === 'refunded'
    ? raw
    : DEFAULT_BUCKET;
}

// Per-bucket status / auction_id predicates (applied inline at each query
// site via `query = query.X(...)` reassignment):
//   live         → on an auction (auction_id NOT NULL, status scheduled/live).
//                  MUST NOT apply `auction_id IS NULL`.
//   inventory    → binned, no auction yet (status='in_inventory', auction_id NULL).
//   not_put_away → printed but unbinned (status='pending_intake'; these rows
//                  carry NULL warehouse_id / intake_bin_id).
//
// Deliberately NOT extracted into a generic helper: a helper that returns the
// Supabase builder makes TypeScript unify the deeply-recursive builder generic
// and trips TS2589 ("type instantiation is excessively deep"). Three short
// inline blocks keep inference local and the build green.

export default async function InventoryPage(props: {
  searchParams: Promise<{
    q?: string;
    source?: string;
    vendor?: string;
    missing?: string;
    bucket?: string;
    warehouse?: string;
  }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  const operatorId = me.operator_id as string;

  const sp = await props.searchParams;
  const searchQ = (sp.q ?? '').trim();
  const sourceFilter = (sp.source ?? '').trim();
  const vendorFilter = (sp.vendor ?? '').trim();
  const warehouseFilter = (sp.warehouse ?? '').trim();
  const bucket = parseBucket(sp.bucket);
  const missing: 'photos' | 'msrp' | 'category' | null =
    sp.missing === 'photos' || sp.missing === 'msrp' || sp.missing === 'category'
      ? sp.missing
      : null;

  // Operator's warehouses (id + name) for the warehouse filter dropdown.
  // RLS already scopes reads to the caller's operator; the explicit
  // operator_id filter keeps the intent obvious and matches the rest of the
  // page. Fetched once regardless of bucket.
  const { data: warehousesData } = await supabase
    .from('warehouses')
    .select('*')
    .eq('operator_id', operatorId)
    .order('name', { ascending: true });
  const warehouses = ((warehousesData ?? []) as unknown as Array<WarehouseLite & { active?: boolean | null }>)
    .filter(isWarehouseActive) as WarehouseLite[];
  // Only honor a warehouse filter that actually belongs to this operator.
  const activeWarehouseId =
    warehouseFilter && warehouses.some((w) => w.id === warehouseFilter)
      ? warehouseFilter
      : '';
  const activeWarehouseName =
    activeWarehouseId
      ? warehouses.find((w) => w.id === activeWarehouseId)?.name ?? null
      : null;

  // ---- List query for the active bucket. -----------------------------------
  // 0103: legacy_lot_code + legacy_platform are surfaced so operators migrating
  // from BidFTA / MaxxSold can find their old codes by search. sticker_code
  // (0141) + upc are surfaced for the lookup tool (Issue 1). 0154: vendor is
  // the supplier label, independent axis from source. M7: the unpicked_up
  // bucket appends the pickups inner-join so it can filter by pickup status.
  const baseCols =
    'id, lot_code, title, status, category, msrp_cents, warehouse_id, intake_bin_id, intake_at, created_at, source, vendor, photo_urls, legacy_lot_code, legacy_platform, sticker_code, upc';
  let query = supabase
    .from('lots')
    .select(bucket === 'unpicked_up' ? `${baseCols}, ${PICKUP_JOIN_SELECT}` : baseCols)
    .eq('operator_id', operatorId)
    .is('deleted_at', null);
  // Bucket predicate (inlined — see the per-bucket note above the component).
  if (bucket === 'live') {
    query = query.not('auction_id', 'is', null).in('status', ['scheduled', 'live']);
  } else if (bucket === 'not_put_away') {
    query = query.eq('status', 'pending_intake');
  } else if (bucket === 'available') {
    // M7 sell axis: ready to add to an auction. status='in_inventory' per the
    // brief (in_inventory lots have auction_id IS NULL by the inventory model).
    query = query.eq('status', 'in_inventory');
  } else if (bucket === 'unsold') {
    // M7 sell axis: closed without a winning bid. Pure status filter (v1).
    // NOTE: a small subset of unsold lots also have a no-show/forfeited pickup
    // and additionally appear under Unpicked-up; that overlap is intentional
    // and mirrors the /worklist Needs-re-lot vs Forfeited split.
    query = query.eq('status', 'unsold');
  } else if (bucket === 'refunded') {
    query = query.eq('status', REFUNDED_STATUS);
  } else if (bucket === 'unpicked_up') {
    // M7 sell axis: a winning bidder no-showed / forfeited pickup. Same
    // forfeited-returns join /worklist uses (lot ← invoice_lots ← invoices ←
    // pickups, filtered to no_show/forfeited). status range is the union of the
    // legacy stranded-'relisted' rows and the no_show-flipped 'unsold' rows.
    query = query
      .in('status', ['unsold', 'relisted'])
      .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
  } else {
    // inventory (default intake-axis bucket)
    query = query.eq('status', 'in_inventory').is('auction_id', null);
  }
  query = query.order('created_at', { ascending: false }).limit(500);
  // Warehouse filter (NULL-safe): pending_intake / not_put_away rows have a
  // NULL warehouse_id, so an .eq('warehouse_id', id) on that bucket simply
  // returns nothing — which is the correct answer ("none of the unbinned
  // lots are at warehouse X").
  if (activeWarehouseId) {
    query = query.eq('warehouse_id', activeWarehouseId);
  }
  if (searchQ) {
    // Bin-location search: resolve the operator's bins whose code matches the
    // query so "4-16-02" / "Bin-01-01" finds the lots binned there. bins has
    // no operator_id column (mig 0094) — operator scope flows through
    // warehouses.operator_id, so we constrain to this operator's warehouse ids
    // (the `warehouses` list already fetched above — no extra warehouse query).
    // When a warehouse filter is active, narrow to just that warehouse so the
    // bin match stays consistent with the rest of the page's scope. Substring
    // match (contains) so a partial code like "16-02" still hits. Capped to
    // keep the IN-list bounded; additive only, never a hard filter.
    const binScopeWarehouseIds = activeWarehouseId
      ? [activeWarehouseId]
      : warehouses.map((w) => w.id);
    let matchedBinIds: string[] = [];
    if (binScopeWarehouseIds.length > 0) {
      const { data: binMatches } = await supabase
        .from('bins')
        .select('id')
        .in('warehouse_id', binScopeWarehouseIds)
        .ilike('code', `%${searchQ}%`)
        .limit(200);
      matchedBinIds = ((binMatches ?? []) as Array<{ id: string }>).map((b) => b.id);
    }
    // 0103: also match on legacy_lot_code so a query for an old platform's
    // code (e.g. "BF57123") still finds the migrated lot.
    // Issue 1 (PATCH-warehouse-lookup): also match sticker_code (0141, stored
    // operator-prefixed `{op.code}:{raw}` — use contains so a raw "PNK4996896"
    // query still hits) and upc, so "where is sticker X / UPC Y?" is answerable.
    // 0154: also match vendor so a search like "Amazon" surfaces every lot
    // tagged with that supplier.
    // Bin-location: OR in `intake_bin_id.in.(…)` when the query matched any of
    // this operator's bin codes — additive, so a search hits the existing text
    // fields OR resolves to a bin's contents.
    const orParts = [
      `lot_code.ilike.${searchQ}%`,
      `title.ilike.%${searchQ}%`,
      `legacy_lot_code.ilike.${searchQ}%`,
      `sticker_code.ilike.%${searchQ}%`,
      `upc.ilike.${searchQ}%`,
      `vendor.ilike.%${searchQ}%`,
    ];
    if (matchedBinIds.length > 0) {
      orParts.push(`intake_bin_id.in.(${matchedBinIds.join(',')})`);
    }
    query = query.or(orParts.join(','));
  }
  if (sourceFilter) {
    query = query.eq('source', sourceFilter);
  }
  if (vendorFilter) {
    query = query.eq('vendor', vendorFilter);
  }
  if (missing === 'photos') {
    query = query.or('photo_urls.eq.{},photo_urls.is.null');
  } else if (missing === 'msrp') {
    query = query.is('msrp_cents', null);
  } else if (missing === 'category') {
    query = query.is('category', null);
  }
  const { data: lotsData } = await query;
  const lots = (lotsData ?? []) as unknown as LotRow[];

  // Issue 1 (PATCH-warehouse-lookup): resolve the raw intake_bin_id /
  // warehouse_id UUIDs to human-readable location. Two scoped lookups (RLS
  // limits each to the caller's operator) → maps → attach per lot. Kept as
  // explicit lookups rather than a PostgREST embed so it's robust regardless
  // of FK-relationship metadata. NULL-safe: not_put_away rows have neither id
  // so they fall through to a "—" location in the table.
  const binIds = Array.from(
    new Set(lots.map((l) => l.intake_bin_id).filter((v): v is string => Boolean(v))),
  );
  const lotWarehouseIds = Array.from(
    new Set(lots.map((l) => l.warehouse_id).filter((v): v is string => Boolean(v))),
  );
  const [binsData, whData] = await Promise.all([
    binIds.length
      ? supabase
          .from('bins')
          .select('id, code, aisle, bay')
          .in('id', binIds)
          .then((r) => (r.data ?? []) as unknown as BinLite[])
      : Promise.resolve<BinLite[]>([]),
    lotWarehouseIds.length
      ? supabase
          .from('warehouses')
          .select('id, name, timezone')
          .in('id', lotWarehouseIds)
          .then((r) => (r.data ?? []) as unknown as WarehouseTzLite[])
      : Promise.resolve<WarehouseTzLite[]>([]),
  ]);
  const binMap = new Map(binsData.map((b) => [b.id, b]));
  const warehouseMap = new Map(whData.map((w) => [w.id, w.name]));
  const warehouseTzMap = new Map(whData.map((w) => [w.id, w.timezone]));
  const enrichedLots: EnrichedLotRow[] = lots.map((l) => {
    const bin = l.intake_bin_id ? binMap.get(l.intake_bin_id) : undefined;
    return {
      ...l,
      warehouseName: l.warehouse_id ? warehouseMap.get(l.warehouse_id) ?? null : null,
      binCode: bin?.code ?? null,
      binAisle: bin?.aisle ?? null,
      binBay: bin?.bay ?? null,
      warehouseTz: l.warehouse_id ? warehouseTzMap.get(l.warehouse_id) ?? null : null,
    };
  });

  // Distinct sources for the source filter dropdown — scoped to the ACTIVE
  // bucket (+ warehouse filter) so the options reflect what's actually shown.
  let sourcesQuery = supabase
    .from('lots')
    .select(bucket === 'unpicked_up' ? `source, ${PICKUP_JOIN_SELECT}` : 'source')
    .eq('operator_id', operatorId)
    .is('deleted_at', null);
  if (bucket === 'live') {
    sourcesQuery = sourcesQuery.not('auction_id', 'is', null).in('status', ['scheduled', 'live']);
  } else if (bucket === 'not_put_away') {
    sourcesQuery = sourcesQuery.eq('status', 'pending_intake');
  } else if (bucket === 'available') {
    sourcesQuery = sourcesQuery.eq('status', 'in_inventory');
  } else if (bucket === 'unsold') {
    sourcesQuery = sourcesQuery.eq('status', 'unsold');
  } else if (bucket === 'refunded') {
    sourcesQuery = sourcesQuery.eq('status', REFUNDED_STATUS);
  } else if (bucket === 'unpicked_up') {
    sourcesQuery = sourcesQuery
      .in('status', ['unsold', 'relisted'])
      .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
  } else {
    sourcesQuery = sourcesQuery.eq('status', 'in_inventory').is('auction_id', null);
  }
  sourcesQuery = sourcesQuery.not('source', 'is', null);
  if (activeWarehouseId) {
    sourcesQuery = sourcesQuery.eq('warehouse_id', activeWarehouseId);
  }
  const { data: sourcesData } = await sourcesQuery;
  const distinctSources = Array.from(
    new Set(
      (sourcesData ?? [])
        .map((r) => (r as unknown as { source: string | null }).source)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ).sort();

  // 0154: distinct vendors for the vendor filter dropdown. Same scoping
  // rule as distinctSources — bucket + warehouse — so the available
  // vendor options always reflect what's actually visible in the table.
  let vendorsQuery = supabase
    .from('lots')
    .select(bucket === 'unpicked_up' ? `vendor, ${PICKUP_JOIN_SELECT}` : 'vendor')
    .eq('operator_id', operatorId)
    .is('deleted_at', null);
  if (bucket === 'live') {
    vendorsQuery = vendorsQuery.not('auction_id', 'is', null).in('status', ['scheduled', 'live']);
  } else if (bucket === 'not_put_away') {
    vendorsQuery = vendorsQuery.eq('status', 'pending_intake');
  } else if (bucket === 'available') {
    vendorsQuery = vendorsQuery.eq('status', 'in_inventory');
  } else if (bucket === 'unsold') {
    vendorsQuery = vendorsQuery.eq('status', 'unsold');
  } else if (bucket === 'refunded') {
    vendorsQuery = vendorsQuery.eq('status', REFUNDED_STATUS);
  } else if (bucket === 'unpicked_up') {
    vendorsQuery = vendorsQuery
      .in('status', ['unsold', 'relisted'])
      .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
  } else {
    vendorsQuery = vendorsQuery.eq('status', 'in_inventory').is('auction_id', null);
  }
  vendorsQuery = vendorsQuery.not('vendor', 'is', null);
  if (activeWarehouseId) {
    vendorsQuery = vendorsQuery.eq('warehouse_id', activeWarehouseId);
  }
  const { data: vendorsData } = await vendorsQuery;
  const distinctVendors = Array.from(
    new Set(
      (vendorsData ?? [])
        .map((r) => (r as unknown as { vendor: string | null }).vendor)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ).sort();

  // ---- Per-bucket counts (HEAD, count:'exact') — drive the tab badges. -----
  // Each mirrors the list scope EXCEPT it ignores search / source / missing
  // so the tab badge is a stable "how many are in this bucket" number. It DOES
  // honor the warehouse + vendor filters so the tabs stay consistent with
  // the active scope. (Vendor 0154 was added alongside warehouse for the same
  // reason — if the operator is looking at "Amazon" inventory, the counts on
  // every bucket tab should show only Amazon lots.)
  const bucketCount = async (b: Bucket): Promise<number> => {
    // unpicked_up needs the pickup inner-join in the count select so the HEAD
    // count reflects the join filter (same idiom as /worklist sectionCount).
    let q = supabase
      .from('lots')
      .select(b === 'unpicked_up' ? `id, ${PICKUP_JOIN_SELECT}` : 'id', {
        count: 'exact',
        head: true,
      })
      .eq('operator_id', operatorId)
      .is('deleted_at', null);
    if (b === 'live') {
      q = q.not('auction_id', 'is', null).in('status', ['scheduled', 'live']);
    } else if (b === 'not_put_away') {
      q = q.eq('status', 'pending_intake');
    } else if (b === 'available') {
      q = q.eq('status', 'in_inventory');
    } else if (b === 'unsold') {
      q = q.eq('status', 'unsold');
    } else if (b === 'refunded') {
      q = q.eq('status', REFUNDED_STATUS);
    } else if (b === 'unpicked_up') {
      q = q
        .in('status', ['unsold', 'relisted'])
        .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
    } else {
      q = q.eq('status', 'in_inventory').is('auction_id', null);
    }
    if (activeWarehouseId) q = q.eq('warehouse_id', activeWarehouseId);
    if (vendorFilter) q = q.eq('vendor', vendorFilter);
    const { count } = await q;
    return count ?? 0;
  };
  const [
    liveCount,
    inventoryCount,
    notPutAwayCount,
    availableCount,
    unsoldCount,
    unpickedUpCount,
    refundedCount,
  ] = await Promise.all([
    bucketCount('live'),
    bucketCount('inventory'),
    bucketCount('not_put_away'),
    bucketCount('available'),
    bucketCount('unsold'),
    bucketCount('unpicked_up'),
    bucketCount('refunded'),
  ]);
  const bucketCounts: Record<Bucket, number> = {
    live: liveCount,
    inventory: inventoryCount,
    not_put_away: notPutAwayCount,
    available: availableCount,
    unsold: unsoldCount,
    unpicked_up: unpickedUpCount,
    refunded: refundedCount,
  };
  // Hidden while empty (always, until 0475 adds the status).
  const visibleBuckets = BUCKET_ORDER.filter(
    (b) => b !== 'refunded' || showRefundedTab(bucketCounts.refunded, bucket === 'refunded'),
  );
  const activeBucketCount = bucketCounts[bucket];

  // Open auctions for the bulk-assign-to-auction dropdown. We pull draft +
  // scheduled auctions only — assigning to a live or closed auction would
  // violate the lifecycle invariant. The InventoryTable client component
  // filters again by the selected lots' warehouse so the operator can't pick
  // an auction at a different location. Only meaningful for the inventory
  // bucket, where assign is enabled.
  const canAssignBucket = bucket === 'inventory';
  const { data: openAuctionsData } = canAssignBucket
    ? await supabase
        .from('auctions')
        .select('id, title, warehouse_id, ends_at, status, warehouses(timezone)')
        .eq('operator_id', operatorId)
        .in('status', ['draft', 'scheduled'])
        .gt('ends_at', new Date().toISOString())
        .order('ends_at', { ascending: true })
    : { data: [] };
  const openAuctions = (openAuctionsData ?? []) as unknown as Array<{
    id: string;
    title: string;
    warehouse_id: string;
    ends_at: string;
    status: string;
    // Embedded warehouse zone so the auction-picker can render the close
    // time in the auction's wall-clock zone (warehouses.timezone), not UTC.
    warehouses: { timezone: string } | { timezone: string }[] | null;
  }>;

  // Export URL inherits current filters (incl. bucket + warehouse + vendor).
  const exportQs = new URLSearchParams();
  if (searchQ) exportQs.set('q', searchQ);
  if (sourceFilter) exportQs.set('source', sourceFilter);
  if (vendorFilter) exportQs.set('vendor', vendorFilter);
  if (missing) exportQs.set('missing', missing);
  if (bucket !== DEFAULT_BUCKET) exportQs.set('bucket', bucket);
  if (activeWarehouseId) exportQs.set('warehouse', activeWarehouseId);
  const exportHref = `/lotting/inventory/export${
    exportQs.toString() ? '?' + exportQs.toString() : ''
  }`;

  const hasActiveFilter = Boolean(
    sourceFilter || vendorFilter || missing || searchQ || activeWarehouseId,
  );
  // Everything EXCEPT the warehouse. The empty state needs to distinguish
  // "this warehouse is genuinely empty" from "this warehouse is empty *given
  // the other filters you have on*" — otherwise a stray vendor filter reads as
  // a whole location having no stock.
  const hasOtherFilters = Boolean(sourceFilter || vendorFilter || missing || searchQ);

  // Build hrefs that preserve other active filters when toggling pills/tabs.
  const buildHref = (overrides: Record<string, string | null>): string => {
    const qs = new URLSearchParams();
    if (searchQ) qs.set('q', searchQ);
    if (sourceFilter) qs.set('source', sourceFilter);
    if (vendorFilter) qs.set('vendor', vendorFilter);
    if (missing) qs.set('missing', missing);
    if (bucket !== DEFAULT_BUCKET) qs.set('bucket', bucket);
    if (activeWarehouseId) qs.set('warehouse', activeWarehouseId);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    return `/lotting/inventory${qs.toString() ? '?' + qs.toString() : ''}`;
  };

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    const lotIds = enrichedLots.map((l) => l.id);
    const startingBidMap = new Map<string, number | null>();
    if (lotIds.length > 0) {
      const { data: bidRows } = await supabase
        .from('lots')
        .select('id, starting_bid_cents')
        .in('id', lotIds);
      for (const row of bidRows ?? []) {
        const r = row as { id: string; starting_bid_cents: number | null };
        startingBidMap.set(r.id, r.starting_bid_cents);
      }
    }

    const formatRowLocation = (lot: EnrichedLotRow): string => {
      if (!lot.warehouseName && !lot.binCode) return '—';
      const parts: string[] = [];
      if (lot.binCode) {
        let bin = `Bin ${lot.binCode}`;
        if (lot.binAisle) {
          bin += ` (Aisle ${lot.binAisle}${lot.binBay ? ` / Bay ${lot.binBay}` : ''})`;
        }
        parts.push(bin);
      }
      return parts.length > 0 ? parts.join(' · ') : '—';
    };

    const formatRowAge = (lot: EnrichedLotRow): string => {
      const iso = lot.intake_at ?? lot.created_at;
      const ms = Date.now() - Date.parse(iso);
      const days = Math.max(0, Math.floor(ms / 86_400_000));
      if (days === 0) return 'Today';
      return `${days}d`;
    };

    const bucketTabs = visibleBuckets.map((b) => ({
      id: b as InventoryBucket,
      label: BUCKET_LABELS[b],
      count: bucketCounts[b],
      href: buildHref({ bucket: b === DEFAULT_BUCKET ? null : b }),
      active: bucket === b,
    }));

    const emptyMessage =
      activeWarehouseId
        ? (
            <>
              <strong>No inventory assigned to {activeWarehouseName ?? 'this warehouse'}</strong>
              <div style={{ marginTop: 6, fontSize: 13 }}>
                0 items in this bucket
                {hasOtherFilters ? ' with the current filters' : ''}. Other warehouses are unaffected — switch above to see them.
              </div>
            </>
          )
        : hasActiveFilter
          ? 'No lots match the current filters in this bucket.'
          : BUCKET_EMPTY_COPY[bucket];

    return (
      <InventoryV2
        bucket={bucket as InventoryBucket}
        bucketLabel={BUCKET_LABELS[bucket]}
        bucketTabs={bucketTabs}
        rows={enrichedLots.map((lot) => ({
          id: lot.id,
          lot_code: lot.lot_code,
          sticker_code: lot.sticker_code,
          display_code: null,
          title: lot.title,
          status: lot.status,
          warehouse_id: lot.warehouse_id,
          warehouseName: lot.warehouseName,
          locationLabel: formatRowLocation(lot),
          startingBidCents: startingBidMap.get(lot.id) ?? null,
          ageLabel: formatRowAge(lot),
          photoUrl: lot.photo_urls?.[0] ?? null,
          source: lot.source,
          vendor: lot.vendor,
          msrpCents: lot.msrp_cents,
          intakenAt: lot.intake_at ?? lot.created_at,
          warehouseTz: lot.warehouseTz,
        }))}
        shownCount={lots.length}
        totalCount={activeBucketCount}
        cappedAt500={lots.length === 500 && activeBucketCount > 500}
        searchQ={searchQ}
        warehouseId={activeWarehouseId}
        warehouseOptions={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        sourceFilter={sourceFilter}
        sourceOptions={distinctSources}
        vendorFilter={vendorFilter}
        vendorOptions={distinctVendors}
        missing={missing}
        buildHref={buildHref}
        exportHref={exportHref}
        emptyMessage={emptyMessage}
        canEdit={me.role === 'admin' || me.role === 'manager'}
        canAssign={canAssignBucket}
        openAuctions={openAuctions}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Inventory"
        action={
          <a
            href={exportHref}
            style={{
              padding: '6px 14px',
              background: 'var(--accent-dim)',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              textDecoration: 'none',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            ⬇ Export CSV
            {hasActiveFilter ? ' (filtered)' : ' (all)'}
          </a>
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: 16 }}>
        Triage your lots by lifecycle stage. <strong>In auction</strong> lots are
        already live for bidders; <strong>In inventory</strong> lots are binned and
        ready for the{' '}
        <Link href="/auctions" style={{ color: 'var(--accent)' }}>
          Auction Builder
        </Link>
        ; <strong>Not put away</strong> lots are field-lotted or arrived and still
        need a bin scan (also in{' '}
        <Link href="/lotting/drafts" style={{ color: 'var(--accent)' }}>
          Drafts
        </Link>
        ). Manifest-expected items that haven&apos;t arrived live in{' '}
        <Link href="/lotting/manifest-pool" style={{ color: 'var(--accent)' }}>
          Manifest pool
        </Link>
        .
      </p>

      {/* Bucket tabs — each shows a live count and drives the list query. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {visibleBuckets.map((b) => (
          <BucketTab
            key={b}
            href={buildHref({ bucket: b === DEFAULT_BUCKET ? null : b })}
            label={BUCKET_LABELS[b]}
            count={bucketCounts[b]}
            active={bucket === b}
          />
        ))}
      </div>

      {/* Active-filter scope banner. */}
      {hasActiveFilter && (
        <div
          style={{
            padding: '10px 14px',
            marginBottom: 16,
            borderRadius: 6,
            border: '1px solid var(--accent)',
            background: 'var(--accent-dim)',
            fontSize: 13,
            maxWidth: 720,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--accent)', fontWeight: 800, letterSpacing: 0.4 }}>
            VIEWING / EXPORTING:
          </span>
          <span style={{ color: 'var(--fg)' }}>
            Bucket <strong style={{ color: 'var(--accent)' }}>{BUCKET_LABELS[bucket]}</strong>
          </span>
          {activeWarehouseName && (
            <span style={{ color: 'var(--fg)' }}>
              Warehouse <strong style={{ color: 'var(--accent)' }}>{activeWarehouseName}</strong>
            </span>
          )}
          {sourceFilter && (
            <span style={{ color: 'var(--fg)' }}>
              Source <strong style={{ color: 'var(--accent)' }}>{sourceFilter}</strong>
            </span>
          )}
          {vendorFilter && (
            <span style={{ color: 'var(--fg)' }}>
              Vendor <strong style={{ color: 'var(--accent)' }}>{vendorFilter}</strong>
            </span>
          )}
          {missing && (
            <span style={{ color: 'var(--fg)' }}>
              Missing <strong style={{ color: 'var(--accent)' }}>{missing}</strong>
            </span>
          )}
          {searchQ && (
            <span style={{ color: 'var(--fg)' }}>
              Search <strong style={{ color: 'var(--accent)' }}>&quot;{searchQ}&quot;</strong>
            </span>
          )}
          <span style={{ color: 'var(--fg-muted)' }}>
            ({lots.length} lot{lots.length === 1 ? '' : 's'} shown)
          </span>
        </div>
      )}

      {/* Single stat card — count of lots in the active bucket. */}
      <div style={{ marginBottom: 16, maxWidth: 720 }}>
        <Stat label={BUCKET_LABELS[bucket]} value={String(activeBucketCount)} />
      </div>

      {/* BUG-LL-07: surface the 500-row cap when it bites. The stat above
          shows the true count from a separate HEAD query, so the mismatch is
          observable; this banner makes it actionable. */}
      {lots.length === 500 && activeBucketCount > 500 && (
        <div
          style={{
            padding: 12,
            background: 'var(--bg-elev)',
            border: '1px solid var(--warning, #fbbf24)',
            color: 'var(--warning, #fbbf24)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          Showing the most recent 500 of {activeBucketCount} items. Apply a
          search/source/quality/warehouse filter to narrow, or use the CSV
          export (above) which returns up to 5000 rows.
        </div>
      )}

      {/* Search + source + warehouse filter form. GET so the URL captures
          state. The active bucket rides along as a hidden field so submitting
          the form doesn't bounce back to the default bucket. */}
      <form
        method="GET"
        style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', maxWidth: 720 }}
      >
        {missing && <input type="hidden" name="missing" value={missing} />}
        {bucket !== DEFAULT_BUCKET && <input type="hidden" name="bucket" value={bucket} />}
        <input
          type="search"
          name="q"
          defaultValue={searchQ}
          placeholder="Lot code, title, sticker, UPC, or bin…"
          style={{
            flex: 1,
            minWidth: 200,
            padding: '6px 10px',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        {/* FilterSelect (not a bare <select>): these apply on change. A plain
            select here meant picking a warehouse did nothing until you also
            clicked Search, so "Dodge City" left Harrison's inventory on screen
            and looked like the filter was broken (field report 2026-07-27). */}
        {warehouses.length > 0 && (
          <FilterSelect
            name="warehouse"
            defaultValue={activeWarehouseId}
            ariaLabel="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </FilterSelect>
        )}
        {distinctSources.length > 0 && (
          <FilterSelect
            name="source"
            defaultValue={sourceFilter}
            ariaLabel="Filter by source or VRID"
          >
            <option value="">All sources / VRIDs</option>
            {distinctSources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </FilterSelect>
        )}
        {/* 0154: vendor filter — supplier axis, distinct from source (VRID).
            Mirrors the source select directly above; both compose so an
            operator can scope to (e.g.) "Amazon from Load lex1". */}
        {distinctVendors.length > 0 && (
          <FilterSelect name="vendor" defaultValue={vendorFilter} ariaLabel="Filter by vendor">
            <option value="">All vendors</option>
            {distinctVendors.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </FilterSelect>
        )}
        <button
          type="submit"
          style={{
            padding: '6px 12px',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Apply
        </button>
        {hasActiveFilter && (
          <a
            href={buildHref({ q: null, source: null, vendor: null, missing: null, warehouse: null })}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Clear
          </a>
        )}
      </form>

      {/* Cleanup-quality pills (no-photos / no-msrp / no-category). */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Quality:
        </span>
        <FilterPill
          href={buildHref({ missing: missing === 'photos' ? null : 'photos' })}
          label="No photos"
          active={missing === 'photos'}
        />
        <FilterPill
          href={buildHref({ missing: missing === 'msrp' ? null : 'msrp' })}
          label="No MSRP"
          active={missing === 'msrp'}
        />
        <FilterPill
          href={buildHref({ missing: missing === 'category' ? null : 'category' })}
          label="No category"
          active={missing === 'category'}
        />
      </div>

      {/* Per-source quick-export chips — scoped to the active bucket. */}
      {distinctSources.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 16,
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '10px 12px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--bg-elev)',
            maxWidth: 720,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              fontWeight: 700,
            }}
          >
            Export by truck:
          </span>
          {distinctSources.map((src) => {
            const qs = new URLSearchParams();
            qs.set('source', src);
            if (bucket !== DEFAULT_BUCKET) qs.set('bucket', bucket);
            if (activeWarehouseId) qs.set('warehouse', activeWarehouseId);
            return (
              <a
                key={src}
                href={`/lotting/inventory/export?${qs.toString()}`}
                title={`Download CSV of every ${BUCKET_LABELS[bucket].toLowerCase()} lot tagged ${src}`}
                style={{
                  padding: '4px 10px',
                  background: 'var(--accent-dim)',
                  color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                ⬇ {src}
              </a>
            );
          })}
        </div>
      )}

      {lots.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            maxWidth: 720,
          }}
        >
          {/* Name the warehouse explicitly when one is selected. "No lots match
              the current filters" next to a location switcher is ambiguous —
              with two warehouses live, staff need to read "Dodge City has
              nothing" and not wonder whether they are looking at the wrong
              place (field report 2026-07-27). */}
          {activeWarehouseId ? (
            <>
              <strong style={{ color: 'var(--fg)' }}>
                No inventory assigned to {activeWarehouseName ?? 'this warehouse'}
              </strong>
              <div style={{ marginTop: 6, fontSize: 13 }}>
                0 items in this bucket
                {hasOtherFilters ? ' with the current filters' : ''}. Other warehouses are
                unaffected — switch above to see them.
              </div>
            </>
          ) : hasActiveFilter ? (
            'No lots match the current filters in this bucket.'
          ) : (
            BUCKET_EMPTY_COPY[bucket]
          )}
        </div>
      ) : (
        <InventoryTable
          canEdit={me.role === 'admin' || me.role === 'manager'}
          canAssign={canAssignBucket}
          lots={enrichedLots}
          openAuctions={openAuctions}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'inline-block',
        minWidth: 180,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 900,
          color: 'var(--fg)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FilterPill({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      style={{
        padding: '6px 14px',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0.4,
      }}
    >
      {label}
    </Link>
  );
}

// Bucket tab pill — same visual language as FilterPill but renders a count
// badge so the operator can see all three bucket sizes at a glance.
function BucketTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.4,
        textDecoration: 'none',
      }}
      aria-current={active ? 'page' : undefined}
    >
      <span>{label}</span>
      <span
        style={{
          minWidth: 20,
          textAlign: 'center',
          padding: '1px 7px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 800,
          background: active ? 'var(--accent)' : 'var(--bg-elev)',
          color: active ? 'var(--bg)' : 'var(--fg-muted)',
        }}
      >
        {count}
      </span>
    </Link>
  );
}
