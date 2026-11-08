/**
 * Public landing for an operator's per-auction "Preview QR".
 *
 * The Preview QR (rendered on the operator's auction detail page) encodes
 *   https://bingoauctions.com/preview/{auction_id}
 *
 * Its PRIMARY consumer is the BinGo Auctions bidder app's in-app scanner (scan tab),
 * which recognizes this path, calls set_bidder_preview_operator(auction_id),
 * and persists the auction's operator as the bidder's one-time "preview
 * check-in" (Option C, migration 0150). After that, scanning the operator's
 * physical lot stickers resolves operator-scoped.
 *
 * This server handler is only the "scanned with a plain phone camera / no app
 * installed" fallback: 302 to the public auction detail page so the visitor at
 * least sees what they're previewing. The actual preview-context persistence
 * happens in-app — there is nothing to set server-side here.
 *
 * `/preview` is whitelisted in middleware.ts (PUBLIC_ROUTE_PREFIXES) so this
 * is reachable without a session, exactly like `/l/{qr_token}`.
 */

import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bare UUID — same shape used across the public link handlers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ auctionId: string }> }) {
  const { auctionId } = await ctx.params;
  // Well-formed id → the public auction page; anything else → the marketplace.
  const dest = UUID_RE.test(auctionId) ? `/auction/${auctionId}` : '/browse';
  // 302 (not 301): never let a browser/CDN permanently cache this hop.
  return NextResponse.redirect(new URL(dest, req.url), 302);
}
