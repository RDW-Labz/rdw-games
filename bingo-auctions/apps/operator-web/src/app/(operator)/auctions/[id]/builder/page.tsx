// Auction Builder — pick lots and add them to this auction. A `bucket` search
// param picks the SOURCE of lots (B7):
//
//   available    → in_inventory lots with no auction yet (auction_id NULL).
//                  The default + historical behavior. Plain-assigned via
//                  assign_lots_to_auction.
//   unsold       → lots that closed without a winning bid (status='unsold').
//                  These keep their old auction_id, so they're CARRIED OVER
//                  (relisted) into this auction — minting a new lot_code and
//                  preserving the relisted_from_lot_id lineage.
//   unpicked_up  → lots a winning bidder no-showed / forfeited (status in
//                  unsold/relisted + a no_show/forfeited pickup). Same
//                  carryover (relist) path as unsold.
//
// Selecting + committing assigns auction_id + sequential lot_number + flips
// status to 'scheduled' (available) or mints a fresh relisted lot (carryover).

import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PageHeader } from '@/components/Form';
import { loadUnfoundMissing } from '@/lib/missing-items';
import { loadCollectedCarryoverIds } from '@/lib/builder-collected';
import { AuctionBuilder } from './AuctionBuilder';
import { AuctionBuilderLockedV2, AuctionBuilderV2 } from './v2/AuctionBuilderV2';
import { AuctionBuilderIntroV2, buildAuctionBuilderNoticesV2 } from './v2/auction-builder-copy';

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
};

type InventoryLot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  // B7: lot status — needed so the client can mirror inventory's "Carryover"
  // hint and so the available-vs-carryover commit path is unambiguous.
  status: string;
  category_id: string | null;
  category: string | null;
  msrp_cents: number | null;
  starting_bid_cents: number;
  warehouse_id: string | null;
  intake_bin_id: string | null;
  intake_at: string | null;
  photo_urls: string[] | null;
  // Bin code resolved server-side from intake_bin_id (mirrors
  // /lotting/inventory). Lets the client picker's search match a bin code
  // like "RDW-01-01". Null when the lot isn't binned (shouldn't happen for
  // in_inventory lots, but kept nullable for safety).
  binCode: string | null;
};

// B7 source buckets. Mirrors the sell-axis buckets in /lotting/inventory.
type Bucket = 'available' | 'unsold' | 'unpicked_up';
const DEFAULT_BUCKET: Bucket = 'available';
function parseBucket(raw: string | undefined): Bucket {
  return raw === 'available' || raw === 'unsold' || raw === 'unpicked_up'
    ? raw
    : DEFAULT_BUCKET;
}

// Sell-axis buckets that filter lots by a no_show/forfeited pickup via the
// invoice_lots → invoices → pickups inner-join (idiom shared with /worklist
// and /lotting/inventory).
const PICKUP_JOIN_SELECT = 'invoice_lots!inner(invoices!inner(pickups!inner(status)))';

/** PostgREST returns at most this many rows per request no matter what
 *  .limit() asks for, and it does not say it truncated. Anything here that
 *  needs a COMPLETE set has to page. */
const SUPABASE_PAGE = 1000;
const PICKUP_FORFEIT_STATUSES = ['no_show', 'forfeited'];

export default async function BuildAuctionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bucket?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const bucket = parseBucket(sp.bucket);
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

  const { data: auction } = await supabase
    .from('auctions')
    .select('id, title, status, ends_at, last_lot_ends_at, warehouse_id, soft_close_minutes, close_stagger_seconds')
    .eq('id', id)
    .eq('operator_id', me.operator_id as string)
    .single();
  if (!auction) notFound();

  if (auction.status !== 'draft' && auction.status !== 'scheduled') {
    const cookieStoreLocked = await cookies();
    if (isConsoleV2(cookieStoreLocked.get(CONSOLE_UI_COOKIE)?.value)) {
      return (
        <AuctionBuilderLockedV2
          auctionId={id}
          status={auction.status as string}
          backHref={`/auctions/${id}`}
        />
      );
    }
    return (
      <div>
        <PageHeader
          title="Build auction"
          action={
            <Link href={`/auctions/${id}`} className="btn-secondary">
              ← Auction
            </Link>
          }
        />
        <p style={{ color: 'var(--fg-muted)', maxWidth: 720 }}>
          This auction is <strong>{auction.status}</strong>. Lot membership is locked once the
          auction is live or closed.
        </p>
      </div>
    );
  }

  // Source lots for the active bucket, scoped to the auction's warehouse (if
  // one is set) and never including soft-deleted (Trash) lots. The bucket
  // predicate mirrors /lotting/inventory exactly — DO NOT add an
  // `auction_id IS NULL` filter to the carryover buckets: unsold / unpicked-up
  // lots keep their old auction_id, so that filter would return 0 rows.
  const baseCols =
    'id, lot_code, sticker_code, display_code, title, status, category_id, category, msrp_cents, starting_bid_cents, warehouse_id, intake_bin_id, intake_at, photo_urls';
  let inventoryQ = supabase
    .from('lots')
    .select(bucket === 'unpicked_up' ? `${baseCols}, ${PICKUP_JOIN_SELECT}` : baseCols)
    .eq('operator_id', me.operator_id as string)
    .is('deleted_at', null); // 0057: skip soft-deleted (Trash) lots
  if (bucket === 'unsold') {
    // Closed without a winning bid. NO auction_id filter (they keep the old
    // auction_id) — adding one would return nothing.
    inventoryQ = inventoryQ.eq('status', 'unsold');
  } else if (bucket === 'unpicked_up') {
    // Winning bidder no-showed / forfeited. Same forfeited-returns join
    // /worklist + /lotting/inventory use.
    inventoryQ = inventoryQ
      .in('status', ['unsold', 'relisted'])
      .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
  } else {
    // available (default): binned, no auction yet.
    inventoryQ = inventoryQ.eq('status', 'in_inventory').is('auction_id', null);
  }
  inventoryQ = inventoryQ.order('intake_at', { ascending: false }).limit(500);
  if (auction.warehouse_id) {
    inventoryQ = inventoryQ.eq('warehouse_id', auction.warehouse_id);
  }
  const { data: inventory } = await inventoryQ;

  // Sources that ALREADY have an active (non-canceled, non-deleted) relist
  // child — i.e. items already carried over. This mirrors the 0275 relist
  // guard exactly (`relist_source_already_relisted` fires when such a child
  // exists). We hide these from BOTH carryover buckets (list + tab counts)
  // because a carried-over source keeps status='relisted' and — for the
  // unpicked_up bucket, whose predicate is `status IN ('unsold','relisted')`
  // + the forfeited-pickup join — would otherwise LINGER in the list forever.
  // Staff then re-click it and hit the raw guard error (Jared 2026-07-24).
  // One operator-scoped query; used for filtering and counting below.
  const relistedParentIds = new Set<string>();
  {
    // PAGED, and that is the whole fix (2026-08-31). This asked for 50,000 rows
    // in one call to document "give me the complete set" — but PostgREST caps a
    // single select at 1000 regardless of what .limit() requests, silently. With
    // 3,169 matching children on prod, roughly 2,169 parents never reached this
    // set and leaked straight back into the carryover buckets, where they render
    // under the SAME display_code as their live descendant. That is the "same
    // item three times" the owner reported: TEA3822699 appeared as BIN-000400,
    // BIN-004379 and BIN-008895 — three generations of one chair.
    //
    // Which 1000 came back was effectively arbitrary (no ORDER BY), so the
    // duplicates moved around between page loads, which is exactly why this
    // looked flaky rather than broken.
    //
    // lib/marketing/product-feed.ts already pages for this reason and says so.
    // Requesting a number larger than the cap is not a way to defeat it.
    //
    // mig 0290: "active" can NOT be read off canceled_at alone. cancel_auction()
    // (0199) stamps canceled_at as an AUDIT breadcrumb while returning the lot to
    // inventory, so a lot that passed through a canceled auction and was then
    // re-listed carries a stale stamp while being perfectly live. Filtering on
    // canceled_at only would miss such a child, leave its parent in the carryover
    // bucket, and reproduce the exact lingering-item bug this set exists to fix.
    // Status is authoritative: draft/scheduled/live is active regardless of stamp.
    for (let from = 0; ; from += SUPABASE_PAGE) {
      const { data: activeChildren } = await supabase
        .from('lots')
        .select('relisted_from_lot_id')
        .eq('operator_id', me.operator_id as string)
        .not('relisted_from_lot_id', 'is', null)
        .or('canceled_at.is.null,status.in.(draft,scheduled,live)')
        .is('deleted_at', null)
        // A stable order is required for paging to be correct: without it
        // PostgREST may return overlapping or missing rows across ranges.
        .order('id', { ascending: true })
        .range(from, from + SUPABASE_PAGE - 1);
      const page = (activeChildren ?? []) as Array<{ relisted_from_lot_id: string | null }>;
      for (const c of page) {
        if (c.relisted_from_lot_id) relistedParentIds.add(c.relisted_from_lot_id);
      }
      if (page.length < SUPABASE_PAGE) break;
    }
  }

  // Items refunded as missing and not found since. Mig 0345's trigger refuses
  // to relist them, so offering them here only set up a carryover that failed
  // part-way (Jared 2026-10-15). Hidden from every bucket, list and badge.
  const unfoundMissing = await loadUnfoundMissing(supabase);
  // Items a customer already took home (mig 0447): the lot or an ancestor was
  // collected and never refunded or scanned back. Mostly relist copies minted
  // before the 0356 guard; the guard refuses them, so do not offer them.
  // Jared 2026-10-23: 7 on Unpicked-Up / Unsold. Hidden from list and badges.
  const collectedGone = await loadCollectedCarryoverIds(supabase, (auction.warehouse_id as string | null) ?? null);
  const hidden = (id: string) =>
    relistedParentIds.has(id) || unfoundMissing.has(id) || collectedGone.has(id);

  // Resolve intake_bin_id → bin code so the client picker can search by bin
  // (mirrors /lotting/inventory's bin lookup). One scoped lookup keyed on the
  // bin ids actually present on the loaded lots. These lots are already
  // warehouse-scoped (auction.warehouse_id) so the bins all belong to this
  // auction's single warehouse — inherently operator-scoped. NULL-safe: lots
  // without a bin fall through to a null binCode.
  // The .filter() drops already-relisted sources (see relistedParentIds). It's
  // a no-op for the 'available' bucket (in_inventory lots never hold an active
  // child) and the fix for the carryover buckets.
  const inventoryRows = ((inventory ?? []) as unknown as Array<{
    id: string;
    intake_bin_id: string | null;
    [k: string]: unknown;
  }>).filter((l) => !hidden(l.id));
  const builderBinIds = Array.from(
    new Set(
      inventoryRows
        .map((l) => l.intake_bin_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const builderBinCodeMap = new Map<string, string>();
  if (builderBinIds.length > 0) {
    const { data: builderBins } = await supabase
      .from('bins')
      .select('id, code')
      .in('id', builderBinIds);
    for (const b of (builderBins ?? []) as Array<{ id: string; code: string }>) {
      builderBinCodeMap.set(b.id, b.code);
    }
  }
  const inventoryWithBin = inventoryRows.map((l) => ({
    ...l,
    binCode: l.intake_bin_id ? builderBinCodeMap.get(l.intake_bin_id) ?? null : null,
  }));

  const { data: categories } = await supabase
    .from('categories')
    .select('id, slug, name, parent_id')
    .order('sort_order', { ascending: true });

  // How many lots are already in this auction? Drives the lot-number
  // preview ("next lot will be #4") in the client.
  const { count: existingCount } = await supabase
    .from('lots')
    .select('id', { count: 'exact', head: true })
    .eq('auction_id', id)
    .not('lot_number', 'is', null);

  // ---- Per-bucket counts (HEAD) — drive the source-tab badges. Scoped to
  // this auction's warehouse (when set) so the badges agree with what the
  // builder will actually show. Mirrors /lotting/inventory's bucketCount.
  const bucketCount = async (b: Bucket): Promise<number> => {
    // 'available' can use a cheap HEAD count — an in_inventory lot never holds
    // an active relist child, so there is nothing to exclude.
    if (b === 'available') {
      let q = supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .eq('operator_id', me.operator_id as string)
        .is('deleted_at', null)
        .eq('status', 'in_inventory')
        .is('auction_id', null);
      if (auction.warehouse_id) q = q.eq('warehouse_id', auction.warehouse_id);
      const { count } = await q;
      // Subtract unfound-missing lots that would be in this bucket, so the
      // badge matches the list. Usually none; chunked because ids go in the URL.
      let missingHere = 0;
      const missingIds = Array.from(unfoundMissing.keys());
      for (let i = 0; i < missingIds.length; i += 100) {
        let mq = supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .in('id', missingIds.slice(i, i + 100))
          .is('deleted_at', null)
          .eq('status', 'in_inventory')
          .is('auction_id', null);
        if (auction.warehouse_id) mq = mq.eq('warehouse_id', auction.warehouse_id);
        const { count: c } = await mq;
        missingHere += c ?? 0;
      }
      return Math.max(0, (count ?? 0) - missingHere);
    }
    // Carryover buckets: fetch ids (not HEAD) so we can subtract sources that
    // already have an active child, keeping the badge in sync with the list.
    let q = supabase
      .from('lots')
      .select(b === 'unpicked_up' ? `id, ${PICKUP_JOIN_SELECT}` : 'id')
      .eq('operator_id', me.operator_id as string)
      .is('deleted_at', null);
    if (b === 'unsold') {
      q = q.eq('status', 'unsold');
    } else {
      q = q
        .in('status', ['unsold', 'relisted'])
        .in('invoice_lots.invoices.pickups.status', PICKUP_FORFEIT_STATUSES);
    }
    if (auction.warehouse_id) q = q.eq('warehouse_id', auction.warehouse_id);

    // Paged for the same reason as relistedParentIds above: .limit(5000) was
    // capped at 1000, so any bucket larger than that reported a badge stuck at
    // 1000 while the list disagreed. Counting requires every id, because the
    // number shown is "candidates MINUS already-carried-over".
    let total = 0;
    for (let from = 0; ; from += SUPABASE_PAGE) {
      const { data } = await q.order('id', { ascending: true }).range(from, from + SUPABASE_PAGE - 1);
      const rows = (data ?? []) as unknown as Array<{ id: string }>;
      total += rows.filter((r) => !hidden(r.id)).length;
      if (rows.length < SUPABASE_PAGE) break;
    }
    return total;
  };
  const [availableCount, unsoldCount, unpickedUpCount] = await Promise.all([
    bucketCount('available'),
    bucketCount('unsold'),
    bucketCount('unpicked_up'),
  ]);
  const bucketCounts: Record<Bucket, number> = {
    available: availableCount,
    unsold: unsoldCount,
    unpicked_up: unpickedUpCount,
  };

  // INV-1 (a): count of in-inventory, unassigned lots that are binned at a
  // DIFFERENT warehouse than this auction's. Put-away stamps a lot's
  // warehouse_id from its bin, so an on-shelf lot binned elsewhere is silently
  // hidden by the warehouse filter on the available query below. We don't drop
  // that filter (assign_lots_to_auction, mig 0060, enforces same-warehouse — a
  // cross-warehouse assignment would just fail), but we surface the count so the
  // operator knows the lots exist and can switch the auction's warehouse or move
  // the lots. Only meaningful for the 'available' bucket (carryover lots keep
  // their old auction's warehouse and follow a different path).
  let otherWarehouseInventoryCount = 0;
  if (auction.warehouse_id) {
    const { count } = await supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', me.operator_id as string)
      .is('deleted_at', null)
      .eq('status', 'in_inventory')
      .is('auction_id', null)
      .neq('warehouse_id', auction.warehouse_id);
    otherWarehouseInventoryCount = count ?? 0;
  }

  // INV-1 (c): lots that exist but have never been scanned onto a shelf.
  // Reported 2026-08-25: "all those items that we lotted under duplicate do not
  // show up in inventory to put on auction, we can find an item on lot lookup,
  // just not when building auctions." A lot is only auctionable at
  // status='in_inventory', which put-away sets — and `duplicate_lot` mints
  // 'pending_intake' with no bin (0326, deliberately: the copy is a different
  // box and must be put wherever it actually goes). So a duplicated lot is
  // findable by code and invisible here until someone scans it into a bin,
  // and nothing on this page said so. Count them and say where they went.
  let awaitingPutAwayCount = 0;
  {
    let q = supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', me.operator_id as string)
      .is('deleted_at', null)
      .eq('status', 'pending_intake')
      .is('auction_id', null);
    // pending_intake lots have no bin, so warehouse_id is usually unset — only
    // narrow when the lot actually carries one, or the banner reads zero.
    if (auction.warehouse_id) {
      q = q.or(`warehouse_id.eq.${auction.warehouse_id},warehouse_id.is.null`);
    }
    const { count } = await q;
    awaitingPutAwayCount = count ?? 0;
  }

  // INV-1 (d): lots that ARE on a shelf but never left `draft`. Reported
  // 2026-08-26: "Why can I not list the items in the Cage into the auction,
  // nothing shows for the Cage in the Auction builder." All 16 lots on
  // Cage-01-01 were draft — complete listings with photos, prices and bound
  // stickers, sitting on the shelf, invisible here because this page and
  // assign_lots_to_auction both require 'in_inventory'. 0335 promoted the 21
  // that were complete; this count keeps the next batch from being a mystery.
  let shelvedDraftCount = 0;
  {
    let q = supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', me.operator_id as string)
      .is('deleted_at', null)
      .eq('status', 'draft')
      .is('auction_id', null)
      .not('intake_bin_id', 'is', null);
    if (auction.warehouse_id) q = q.eq('warehouse_id', auction.warehouse_id);
    const { count } = await q;
    shelvedDraftCount = count ?? 0;
  }

  // INV-1 (b): the available query is capped at .limit(500). When the true
  // warehouse-scoped available count exceeds what we rendered, lots past 500
  // vanish with no indication. availableCount is the exact HEAD count (same
  // filters as the list query), so compare it against the rendered length to
  // detect the cap. Mirrors the overflow banner in /lotting/inventory.
  const availableOverflow =
    bucket === 'available' && (inventory?.length ?? 0) >= 500 && availableCount > (inventory?.length ?? 0);

  const isCarryover = bucket === 'unsold' || bucket === 'unpicked_up';

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    return (
      <AuctionBuilderV2
        auctionId={id}
        auctionTitle={auction.title as string}
        backHref={`/auctions/${id}`}
        intro={
          <AuctionBuilderIntroV2
            auctionTitle={auction.title as string}
            bucket={bucket}
            firstLotNumber={(existingCount ?? 0) + 1}
          />
        }
        notices={buildAuctionBuilderNoticesV2({
          bucket,
          availableOverflow,
          shownCount: inventory?.length ?? 0,
          availableCount,
          otherWarehouseInventoryCount,
          shelvedDraftCount,
          awaitingPutAwayCount,
        })}
        builder={
          <AuctionBuilder
            auctionId={id}
            warehouseId={(auction.warehouse_id as string | null) ?? null}
            inventory={inventoryWithBin as unknown as InventoryLot[]}
            categories={(categories ?? []) as CategoryRow[]}
            firstLotNumber={(existingCount ?? 0) + 1}
            firstClosesAt={auction.ends_at as string}
            lastClosesAt={(auction.last_lot_ends_at as string | null) ?? null}
            existingLotCount={existingCount ?? 0}
            closeStaggerSeconds={(auction.close_stagger_seconds as number | null) ?? 0}
            activeBucket={bucket}
            bucketCounts={bucketCounts}
          />
        }
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Build auction"
        action={
          <Link href={`/auctions/${id}`} className="btn-secondary">
            ← Auction
          </Link>
        }
      />
      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          maxWidth: 720,
          marginBottom: 16,
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
        }}
      >
        {isCarryover ? (
          <>
            Carry over {bucket === 'unsold' ? 'unsold' : 'unpicked-up'} lots into{' '}
            <strong style={{ color: 'var(--fg)' }}>{auction.title}</strong>. Each carried-over
            lot is <strong style={{ color: 'var(--fg)' }}>relisted</strong> — it gets a brand-new
            lot code and lot number while keeping a link back to the original (its provenance).
            New lot numbers start at <strong style={{ color: 'var(--fg)' }}>#{(existingCount ?? 0) + 1}</strong>.
          </>
        ) : (
          <>
            Pick lots from inventory to add to <strong style={{ color: 'var(--fg)' }}>{auction.title}</strong>.
            Selected items get sequential lot numbers starting at <strong style={{ color: 'var(--fg)' }}>
              #{(existingCount ?? 0) + 1}</strong> and flip to <strong style={{ color: 'var(--fg)' }}>scheduled</strong>.
            Bidders won&apos;t see them until the auction itself is scheduled.
          </>
        )}
      </div>

      {/* INV-1 (b): the available list is capped at 500 rows. Surface the cap
          when it bites so the operator knows lots are hidden and can narrow by
          warehouse/category in the picker below. */}
      {availableOverflow && (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--warning, #fbbf24)',
            color: 'var(--warning, #fbbf24)',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            maxWidth: 720,
            marginBottom: 16,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Showing the most recent {inventory?.length ?? 0} of {availableCount.toLocaleString()}{' '}
          available lots at this warehouse. Use the search and category filters
          below to find older lots that aren&apos;t shown.
        </div>
      )}

      {/* INV-1 (a): in-inventory lots binned at a DIFFERENT warehouse are hidden
          because lots can only be assigned to an auction at the same warehouse
          (assign_lots_to_auction, mig 0060). Tell the operator they exist. */}
      {bucket === 'available' && otherWarehouseInventoryCount > 0 && (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            maxWidth: 720,
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--fg)' }}>
            {otherWarehouseInventoryCount.toLocaleString()}
          </strong>{' '}
          in-inventory lot{otherWarehouseInventoryCount === 1 ? ' is' : 's are'} at other
          warehouses and aren&apos;t shown here. Lots can only be added to an
          auction at the same warehouse — switch this auction&apos;s warehouse or
          move the lots to{' '}
          <strong style={{ color: 'var(--fg)' }}>this</strong> warehouse to include
          them.
        </div>
      )}

      {bucket === 'available' && shelvedDraftCount > 0 && (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            maxWidth: 720,
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--fg)' }}>{shelvedDraftCount.toLocaleString()}</strong>{' '}
          lot{shelvedDraftCount === 1 ? '' : 's'} on a shelf{' '}
          {shelvedDraftCount === 1 ? 'is' : 'are'} still marked{' '}
          <strong style={{ color: 'var(--fg)' }}>draft</strong> — an unfinished
          listing — so {shelvedDraftCount === 1 ? 'it is' : 'they are'} not shown
          here. Open{' '}
          {shelvedDraftCount === 1 ? 'it' : 'them'} from Worklist → Draft and save
          to finish the listing, and {shelvedDraftCount === 1 ? 'it' : 'they'}{' '}
          become available.
        </div>
      )}

      {bucket === 'available' && awaitingPutAwayCount > 0 && (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            maxWidth: 720,
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--fg)' }}>{awaitingPutAwayCount.toLocaleString()}</strong>{' '}
          lot{awaitingPutAwayCount === 1 ? '' : 's'} exist
          {awaitingPutAwayCount === 1 ? 's' : ''} but{' '}
          {awaitingPutAwayCount === 1 ? 'has' : 'have'} never been scanned onto a
          shelf, so {awaitingPutAwayCount === 1 ? 'it is' : 'they are'} not listed
          here. Duplicated lots start this way on purpose — the copy is a
          different box and has to be put where it actually goes. Work them
          through <strong style={{ color: 'var(--fg)' }}>Put away</strong> in the
          field app (or Worklist → Pending intake) and they become available.
        </div>
      )}

      <AuctionBuilder
        auctionId={id}
        warehouseId={(auction.warehouse_id as string | null) ?? null}
        inventory={inventoryWithBin as unknown as InventoryLot[]}
        categories={(categories ?? []) as CategoryRow[]}
        firstLotNumber={(existingCount ?? 0) + 1}
        firstClosesAt={auction.ends_at as string}
        lastClosesAt={(auction.last_lot_ends_at as string | null) ?? null}
        existingLotCount={existingCount ?? 0}
        closeStaggerSeconds={(auction.close_stagger_seconds as number | null) ?? 0}
        activeBucket={bucket}
        bucketCounts={bucketCounts}
      />
    </div>
  );
}
