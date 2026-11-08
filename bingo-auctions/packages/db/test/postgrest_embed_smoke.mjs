#!/usr/bin/env node
/**
 * PostgREST embed smoke — replay the app's real read-path queries against a
 * REAL PostgREST and fail CI on any embed/parse error.
 *
 * Why this exists (2026-08-09 field report): a lineage embed shipped with the
 * FK CONSTRAINT name as its hint — `lots!lots_relisted_from_lot_id_fkey` —
 * which type-checks fine and works for cross-table embeds, but PostgREST
 * refuses constraint-name hints on SELF-referencing FKs (PGRST200 "no
 * relationship found"). Every pickup detail page answered "Pickup not found"
 * in prod for half a day. Nothing in CI executes these select strings against
 * a PostgREST, so nothing could have caught it: the typechecker sees a string,
 * the SQL test suite sees SQL, and Playwright never signs in to a pickup.
 *
 * This runner sends each manifest query to PostgREST (running in CI against
 * the fully-migrated schema) and fails on the error classes that mean THE
 * QUERY ITSELF is malformed:
 *   PGRST1xx — request/parse errors (bad select syntax)
 *   PGRST2xx — schema-cache errors (unknown relationship, ambiguous embed,
 *              unknown table/column)
 * Everything else passes: 200 with zero rows (RLS as anon), and permission
 * errors (42501) — those depend on grants, not on the query's shape.
 *
 * KEEP THE MANIFEST IN SYNC: when an app read path gains or changes an
 * embedded select, copy the select string here verbatim and note the source
 * file. The entries below mirror the shipped code they name.
 *
 * Usage: node postgrest_embed_smoke.mjs <postgrest-base-url>
 */

const QUERIES = [
  {
    name: 'pickup detail (web)',
    source: 'apps/operator-web/src/app/profile/pickup/[id]/page.tsx',
    table: 'invoices',
    select: `id, status, total_cents, paid_at, auction_id, operator_id,
       auctions(title, pickup_starts_at, pickup_ends_at,
         warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
       operators:operators_public(business_name, contact_email),
       invoice_lots(lot_id, lots(title, lot_code, sticker_code, display_code, intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code),
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code))))`,
  },
  {
    name: 'pickup pass items (web)',
    source: 'apps/operator-web/src/lib/pickup-session.ts',
    table: 'invoice_lots',
    select: `invoice_id, picked_up_at,
       lots!inner(id, lot_code, sticker_code, display_code, title, photo_urls, status, warehouse_id,
         warehouse:warehouses(name),
         intake_bin:bins!lots_intake_bin_id_fkey(code, aisle, bay),
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code)))`,
  },
  {
    name: 'receipt primary lot code (web money path)',
    source: 'apps/operator-web/src/lib/invoice-lot-code.ts',
    table: 'invoice_lots',
    select: `lots(lot_code, sticker_code, display_code,
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code)))`,
  },
  {
    name: 'pickup list (web)',
    source: 'apps/operator-web/src/app/profile/pickup/page.tsx',
    table: 'invoices',
    select: `id, paid_at, auction_id, operator_id,
       auctions(title, pickup_starts_at, pickup_ends_at,
         warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
       operators:operators_public(business_name)`,
  },
  {
    name: 'browse lots (web)',
    source: 'apps/operator-web/src/lib/browse-lots.ts',
    table: 'lots',
    select:
      'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, category_id, auction_id, condition, msrp_cents, status',
  },
  {
    name: 'lot detail (bidder app)',
    source: 'apps/bidder-app/app/lot/[id].tsx',
    table: 'lots',
    select:
      'id, lot_code, sticker_code, display_code, title, description, current_bid_cents, starting_bid_cents, close_at, status, msrp_cents, condition, bid_count, winner_bidder_id, flat_price_cents, dutch_start_cents, dutch_floor_cents, dutch_decline_per_minute_cents, photo_urls, operator_id, auction_id, category, brand, model, upc, asin, fnsku, lpn, mpn, product_sku, site_sku, manufacture_sku, auctions(format, starts_at, prebid_enabled, pickup_ends_at, bid_increment_schedule, buyer_premium_bps, warehouses(timezone)), operators:operators_public(business_name, logo_url, brand_color, offers_shipping, bid_increment_schedule, default_buyer_premium_bps)',
  },
  {
    name: 'pickup pass (bidder app)',
    source: 'apps/bidder-app/app/pickup/[id].tsx',
    table: 'invoices',
    select: `id,
         invoice_lots(
           lot_id,
           picked_up_at,
           refunded_at,
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
  },
  {
    // 2026-10-14: shipped as a bare `lots!inner(...)` — ambiguous with
    // lots.current_bid_id → bids (PGRST201), so the console showed
    // "No bids recorded" for every bidder.
    name: 'bidder detail bid history (console)',
    source: 'apps/operator-web/src/app/(operator)/bidders/[id]/page.tsx',
    table: 'bids',
    select:
      'id, amount_cents, max_amount_cents, is_auto, placed_at, lot_id, lots!lot_id!inner(title, lot_code, sticker_code, display_code, auction_id, operator_id, warehouses(timezone))',
  },
  {
    name: 'bidder detail invoices (console)',
    source: 'apps/operator-web/src/app/(operator)/bidders/[id]/page.tsx',
    table: 'invoices',
    select:
      'id, status, total_cents, application_fee_cents, paid_at, created_at, auction_id, auctions(title, warehouses(timezone))',
  },
  {
    name: 'my bids (bidder app)',
    source: 'apps/bidder-app/app/(tabs)/my-bids.tsx',
    table: 'bids',
    select:
      'lot_id, amount_cents, max_amount_cents, placed_at, lot:lots!lot_id(id, lot_code, sticker_code, display_code, title, status, current_bid_cents, close_at, winner_bidder_id, auction_id, photo_urls)',
  },
  {
    name: 'profile stats wins (bidder app)',
    source: 'apps/bidder-app/app/profile/stats.tsx',
    table: 'bids',
    select: 'lot_id, lots!lot_id ( id, winner_bidder_id )',
  },
  {
    name: 'auction header (bidder app)',
    source: 'apps/bidder-app/app/auction/[id].tsx',
    table: 'auctions',
    select:
      'id, title, status, ends_at, last_lot_ends_at, operator_id, operators:operators_public(business_name, logo_url, brand_color), warehouses(timezone)',
  },
];

const base = process.argv[2];
if (!base) {
  console.error('usage: postgrest_embed_smoke.mjs <postgrest-base-url>');
  process.exit(2);
}

// Query-shape failures. Permission (42501) and empty results are fine — they
// depend on role grants, not on whether the select string resolves.
const FATAL_CODE = /^PGRST[12]\d\d$/;

// Optional: when pointed at a Supabase gateway instead of a bare PostgREST,
// the apikey header is required to reach PostgREST at all.
const headers = {};
if (process.env.POSTGREST_APIKEY) {
  headers.apikey = process.env.POSTGREST_APIKEY;
  headers.Authorization = `Bearer ${process.env.POSTGREST_APIKEY}`;
}

// postgrest-js strips all unquoted whitespace from the select string before
// sending (PostgrestQueryBuilder "Remove whitespaces except when quoted"), so
// the multiline template literals in app code never reach PostgREST as-is.
// Mirror that exactly — PostgREST v14 rejects raw newlines with PGRST100,
// which is transport fidelity, not a query-shape problem.
function cleanColumns(columns) {
  let quoted = false;
  return columns
    .split('')
    .map((c) => {
      if (/\s/.test(c) && !quoted) return '';
      if (c === '"') quoted = !quoted;
      return c;
    })
    .join('');
}

let failed = 0;
for (const q of QUERIES) {
  const url = `${base.replace(/\/$/, '')}/${q.table}?${new URLSearchParams({
    select: cleanColumns(q.select),
    limit: '1',
  })}`;
  let res, body;
  try {
    res = await fetch(url, { headers });
    body = await res.text();
  } catch (e) {
    console.error(`FAIL  ${q.name} — network: ${e.message}`);
    failed++;
    continue;
  }
  let code = null;
  try {
    code = JSON.parse(body)?.code ?? null;
  } catch {
    /* non-JSON body (e.g. an array) — fine */
  }
  if (res.ok) {
    console.log(`ok    ${q.name}`);
  } else if (code && FATAL_CODE.test(code)) {
    console.error(`FAIL  ${q.name} (${q.source})`);
    console.error(`      HTTP ${res.status} ${code}: ${body.slice(0, 500)}`);
    failed++;
  } else {
    // Permission / RLS / other non-shape error: the embed resolved.
    console.log(`ok    ${q.name} (non-shape error tolerated: HTTP ${res.status}${code ? ' ' + code : ''})`);
  }
}

if (failed) {
  console.error(`\n${failed} embed quer${failed === 1 ? 'y' : 'ies'} failed shape validation.`);
  process.exit(1);
}
console.log(`\nAll ${QUERIES.length} app read-path queries resolve against PostgREST.`);
