/**
 * Universal-link handler for printed lot QR stickers.
 *
 * Every QR sticker on a physical lot encodes  https://bingoauctions.com/l/{qr_token}.
 * This handler:
 *   - Looks up the qr_token via the SECURITY DEFINER `resolve_lot_by_qr_token`
 *     RPC (no auth required — public RPC granted to `anon` in migration 0103).
 *   - 302-redirects to the canonical SEO URL  /lot/{lot_code}.
 *   - Returns 404 if the token is unknown / has been rotated.
 *
 * The redirect is intentional: stickers carry the rotatable token so we
 * can revoke a sticker without changing the bidder-shareable URL. Bidders
 * who land here from a scanner get bookmarked at the stable /lot/{code}
 * SEO URL, not the rotatable token.
 *
 * Bidder-app deep link interception: the bidder-app's Expo Router config
 * registers bingoauctions.com/l/* as a Universal Link (iOS) / App Link
 * (Android). When the app is installed, iOS opens the URL in-app and the
 * deep-link handler navigates to the in-app /lot/[id] screen instead.
 * This server handler is the "no app installed" fallback.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// Bare UUID. Matches the bin-token regex used elsewhere — same shape, different table.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  if (!UUID_RE.test(token)) {
    // Don't leak whether tokens-of-the-right-shape exist vs not. A
    // visitor who fat-fingers the URL just sees 404. Real stickers
    // always encode well-formed UUIDs because they're printed by the
    // /api/lot/qr-sheet route below.
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('resolve_lot_by_qr_token', {
    p_token: token,
  });

  if (error) {
    console.error('[l/token] resolve_lot_by_qr_token failed', error);
    return new NextResponse('Internal error', { status: 500 });
  }

  // The RPC returns SETOF (a TABLE function). When no row matches, supabase
  // returns an empty array; we 404 in that case rather than redirect to a
  // dead URL.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.lot_code) {
    return new NextResponse('Lot not found', { status: 404 });
  }

  // 302 (Found) rather than 301 (Permanent) — qr_token can be rotated, so
  // we never want browsers/CDNs caching the redirect target permanently.
  const dest = new URL(`/lot/${encodeURIComponent(row.lot_code)}`, req.url);
  return NextResponse.redirect(dest, 302);
}
