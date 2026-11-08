// GET /api/email/unsubscribe?b=<bidder_id>&sig=<hmac>
//
// One-click marketing unsubscribe (mig 0230). The link is embedded in every
// marketing_digest email footer; the sig is an HMAC of the bidder id with
// CRON_SECRET (see unsubscribeSig in lib/cron/email-drain.ts), so the URL
// works signed-out and can't be forged to unsubscribe someone else en masse.
// Only flips bidders.marketing_emails_enabled — transactional email (win,
// receipt, outbid, pickup) is untouched.

import { timingSafeEqual } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { unsubscribeSig } from '@/lib/cron/email-drain';

export const runtime = 'nodejs';

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <div style="max-width:480px;margin:15vh auto;padding:32px;background:#fff;border:1px solid #e5e7ec;border-radius:8px;text-align:center">
    <h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
    <p style="font-size:14px;color:#46505f;margin:0 0 20px">${body}</p>
    <a href="https://bingoauctions.com/browse" style="color:#16a34a;font-weight:700;text-decoration:none">Browse live auctions →</a>
  </div>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const bidderId = url.searchParams.get('b') ?? '';
  const sig = url.searchParams.get('sig') ?? '';

  const expected = unsubscribeSig(bidderId);
  const valid =
    bidderId.length > 0 &&
    sig.length === expected.length &&
    timingSafeEqual(Buffer.from(sig), Buffer.from(expected));

  if (!valid) {
    return page('Link not valid', 'This unsubscribe link is invalid or expired. Manage emails from your profile instead.');
  }

  const admin = getSupabaseAdmin();
  await admin.from('bidders').update({ marketing_emails_enabled: false }).eq('id', bidderId);

  return page(
    "You're unsubscribed",
    "You won't get marketing emails from BinGo Auctions anymore. Win, receipt, and pickup emails still arrive — those are part of bidding.",
  );
}
