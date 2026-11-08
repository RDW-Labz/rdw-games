/**
 * /llms.txt — plain-markdown site summary for AI crawlers and answer
 * engines (ChatGPT, Claude, Perplexity, Google AI Overviews). The llms.txt
 * convention: an H1, a one-line blockquote summary, then link sections —
 * so an LLM can answer "what is BinGo Auctions / how does it work / where
 * is pickup" without crawling and re-assembling the whole site.
 *
 * Business identity + category list come from the DB (same loaders the
 * JSON-LD uses), cached for an hour — this changes rarely and crawler
 * traffic shouldn't touch Supabase per-hit.
 */

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { loadPrimaryBusiness, SITE_URL } from '@/lib/seo';

export const runtime = 'nodejs';
export const revalidate = 3600;

export async function GET() {
  const biz = await loadPrimaryBusiness();

  let categoryLines = '';
  try {
    const { data } = await getSupabaseAdmin()
      .from('categories')
      .select('slug, name')
      .is('parent_id', null)
      .order('sort_order')
      .limit(24);
    const rows = (data ?? []) as Array<{ slug: string | null; name: string | null }>;
    categoryLines = rows
      .filter((c) => c.slug && c.name)
      .map((c) => `- [${c.name}](${SITE_URL}/category/${c.slug}): ${c.name} lots at auction`)
      .join('\n');
  } catch {
    // Category list is nice-to-have; the rest of the file still renders.
  }

  const location = biz?.address
    ? `${biz.address.city}, ${biz.address.state}`
    : 'the United States';

  const body = `# BinGo Auctions

> Online liquidation auction house in ${location}. Overstock, customer returns, and closeout inventory sold in timed online auctions at bingoauctions.com — bid free, pay automatically when you win, and pick up locally at our warehouse.

Key facts:

- BinGo Auctions is the auctioneer, seller, and merchant of record for every lot — no third-party sellers.
- Bidding is free with an account. Auctions use a soft close (last-minute bids extend the lot) and support maximum/proxy bids.
- Winning invoices (hammer price + buyer's premium + applicable sales tax) are charged to the card on file automatically; receipts are emailed.
- All lots are picked up in person at the warehouse in ${location} during the posted pickup window. Items are not transferrable.
- Condition grades: Appears New, Open Box, Good, and As-Is. Every lot has real photos taken in our warehouse.
- Programs: phone-linked loyalty points earned at our stores and auctions (redeemable for auction credit), a $5-give/$5-get referral program, and tax-exempt purchasing for resellers with a valid resale certificate.

## Start here

- [Live and upcoming auctions](${SITE_URL}/browse): every open lot, filterable by category, condition, and price
- [How it works](${SITE_URL}/how-it-works): intake, bidding, payment, and pickup explained end to end (with FAQ)
- [Create a free account](${SITE_URL}/signup): sign up to bid
- [Support](${SITE_URL}/support): contact and help

## Categories

${categoryLines || `- [Browse all](${SITE_URL}/browse)`}

## Policies

- [Terms of service](${SITE_URL}/legal/terms)
- [Privacy policy](${SITE_URL}/legal/privacy)
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
