// GET /catalog/meta.csv — Meta (Facebook/Instagram) commerce catalog feed.
//
// Point Commerce Manager at this URL:
//   Commerce Manager -> Catalog -> Data sources -> Add items
//     -> Scheduled feed -> https://bingoauctions.com/catalog/meta.csv
//     -> Hourly
//
// Hourly matters. The feed renders live DB state, so a lot that has closed
// flips to `availability: out of stock` the instant it closes — but Meta only
// learns that when it next fetches. The fetch interval IS the worst-case
// window in which an ad can point at a closed auction. See lib/marketing/
// product-feed.ts for why closed lots are emitted as out-of-stock for a few
// days instead of just being dropped.
//
// Google Merchant Center accepts the same column set if we ever want it.
//
// ── The custom labels, and the product sets to build from them ───────────
//   custom_label_0  auction title
//   custom_label_1  close date (YYYY-MM-DD)
//   custom_label_2  category demand tier: proven | steady | slow | unproven
//   custom_label_3  this lot's own bidding: bids-0 | bids-1-2 | bids-3-5 |
//                   bids-6-plus
//
// Labels 2 and 3 exist so nobody has to choose items by hand. In Commerce
// Manager -> Catalog -> Product sets:
//
//   "Proven categories"  custom_label_2 is proven
//        ~200 live lots, the ten categories that measurably draw the most
//        bidders (migration 0343). Refreshes itself hourly as lots close.
//   "Hot right now"      custom_label_3 is bids-3-5 or bids-6-plus
//        Whatever already has bidding on it, category-blind. Smaller and
//        more volatile, and the better starting audience: these are items
//        the existing customer base has already voted for.
//
// Point an Advantage+ Catalog campaign at either set and Meta builds the
// ads from live inventory itself.
//
// ── Why this is public ───────────────────────────────────────────────────
// Meta's crawler is unauthenticated, and every field here (title, photo,
// current bid, close time, link) is already rendered on the public /browse
// and /lot pages. So this exposes nothing new — it is the same public catalog
// in a different serialization. Nothing operator-internal (cost basis, source
// pallet, bidder data, sticker codes) is included, and demo + unlisted
// auctions are filtered out upstream.

import { buildMetaFeed } from '@/lib/marketing/product-feed';

export const runtime = 'nodejs';
// Live DB state — never prerender or cache this at build time.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { csv, total, inStock, skipped, proven } = await buildMetaFeed();

    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        // Meta re-fetches on its own schedule; a short shared cache absorbs
        // duplicate/retry fetches without letting a closed lot linger.
        'cache-control': 'public, max-age=300, s-maxage=300',
        'content-disposition': 'inline; filename="bingo-meta-catalog.csv"',
        // Cheap observability: readable in a curl -I without parsing the body.
        'x-feed-items': String(total),
        'x-feed-in-stock': String(inStock),
        'x-feed-skipped': String(skipped),
        // How many live lots the `custom_label_2 = proven` product set holds
        // right now. If this ever goes near zero the ad set has nothing to
        // serve, and that is the number to check first.
        'x-feed-proven': String(proven),
      },
    });
  } catch (err) {
    // A 500 with no body makes Meta mark the fetch failed and RETAIN the last
    // good catalog, which is the safe outcome. Returning a partial or empty
    // 200 would instead wipe the catalog or, worse, be read as "everything is
    // still in stock".
    console.error('[meta-catalog] feed build failed', err);
    return new Response('feed unavailable\n', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
