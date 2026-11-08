// Drains notifications_outbox via Resend for email delivery. Port of
// packages/auction-engine/src/email.ts. Uses the same row but a separate
// state column (emailed_at, email_attempt_count, last_email_error) so push
// and email deliveries advance independently.

import { Resend } from 'resend';
import { SAVER_SKIP_REASON, cycleStart, isEssentialEmailKind, quotaConfig, saverOn } from '@/lib/email-quota';
import { createHmac } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { OUTBID_HEADLINE, OUTBID_TIE_RULE, outbidBody } from '@auction-platform/shared';
import { cdnImageUrl } from '@/lib/img-proxy';
import { DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { appendOffsiteEmailBlock, type OffsiteNotificationCopy } from '@/lib/offsite-notification-copy';
import {
  invoiceIdsForOffsiteLoad,
  loadOffsiteNotificationCopyByInvoiceId,
  offsiteCopyForRow,
} from '@/lib/notification-offsite-load';

// Signed one-click unsubscribe for marketing kinds (mig 0230). HMAC over the
// bidder id with CRON_SECRET — same secret the /api/email/unsubscribe route
// verifies with, no DB token table needed.
export function unsubscribeSig(bidderId: string): string {
  const secret = process.env.CRON_SECRET ?? '';
  return createHmac('sha256', secret).update(`unsub:${bidderId}`).digest('hex').slice(0, 32);
}

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

const FROM = process.env.RESEND_FROM_EMAIL ?? 'BinGo Auctions <no-reply@bingoauctions.com>';
const APP_URL = process.env.PUBLIC_APP_URL ?? 'https://bingoauctions.com';

type OutboxRow = {
  id: string;
  // NB: bidder-targeted kinds + operator-targeted kinds share this table.
  // The drain resolves the recipient email via bidders first, then falls
  // back to operator_users (see "Audit C5" comment near recipient lookup).
  kind:
    | 'outbid'
    | 'won'
    | 'pickup_ready'
    | 'pickup_confirmed'
    | 'dispute_update'
    | 'closing_soon'
    | 'saved_search_hit'
    // Operator-targeted (ai-budget-checks cron). target_user_id is an
    // operator admin's auth.users.id, not a bidder.
    | 'ai_budget_50'
    | 'ai_budget_80'
    | 'ai_budget_100'
    // Operator-targeted payout events (STRIPE-P1-1, 2026-05-24 audit).
    | 'payout_failed'
    | 'payout_paid'
    // Operator-targeted dispute notifications.
    | 'dispute_opened'
    // Bidder-targeted payment failure.
    | 'payment_failed'
    // Bidder-targeted payment receipt (enum from mig 0167; producers wired
    // 2026-07-05: auto-charge success, Square webhook backstop, staff
    // mark-paid — all share idempotency_key 'receipt:{invoice_id}').
    | 'payment_succeeded'
    // Bidder-targeted onboarding nudge (mig 0228): registered >24h, no card.
    | 'add_card_nudge'
    // Bidder-targeted referral credit granted (mig 0229) — both sides.
    | 'referral_credited'
    // Marketing digest (mig 0230) — email-only; the push drain skips it.
    | 'marketing_digest'
    // Segmented marketing campaigns (mig 0292) — email-only, same as the
    // digest. Copy comes from the marketing_campaigns row, not this file.
    | 'marketing_campaign'
    // One-time referral-program announcement (mig 0231) — also email-only.
    | 'referral_announcement'
    // One-time loyalty announcement (mig 0238) — also email-only.
    | 'loyalty_announcement'
    // Auth-orphan onboarding reminder (mig 0239) — email-only. target is an
    // auth user with NO bidders row, so the recipient email rides in
    // payload.email (the bidders/operator_users lookups can't resolve it).
    | 'onboarding_nudge'
    // One-off 2026-07-06 card-save-outage apology (mig 0239) — email-only.
    | 'card_fix_notice';
  target_user_id: string;
  payload: Record<string, unknown>;
  email_attempt_count: number;
};

type EmailContent = { subject: string; html: string; text: string };

// Audit EMAIL-C1 (2026-05-24): Resend rejects HTML-only sends to many
// inboxes' spam filters more aggressively than multipart/alternative
// mail. Strip tags from the rendered HTML so every send includes a
// plaintext alternative. Cheap and good enough — these are short
// transactional emails, not marketing layouts.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

function fmtCents(cents: unknown): string | null {
  if (typeof cents !== 'number') return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(heading: string, body: string, ctaLabel: string, ctaUrl: string): string {
  // E-6 (2026-05-24 audit): inbox-preview text. Derived from heading + body
  // first sentence so each kind gets a meaningful preview without per-call
  // plumbing. Strip HTML tags from body before truncation so we don't emit
  // raw markup in the preview.
  const bodyText = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const preheader = `${heading} — ${bodyText.slice(0, 90)}${bodyText.length > 90 ? '…' : ''}`;
  return `<!doctype html>
<html><head><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <!-- E-6: hidden preheader for inbox previews. mso-hide:all keeps Outlook
       from rendering it; the inline style block neutralises Gmail / iOS Mail. -->
  <span style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:transparent">${escape(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px">
      <!-- E-5: width="100%" + max-width keeps the card scaling down on
           mobile viewports; the fixed width="560" overflowed at <600px. -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e5e7ec;max-width:560px">
        <tr><td style="padding:32px">
          <h1 style="font-size:22px;margin:0 0 12px">${escape(heading)}</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#46505f">${body}</p>
          <a href="${ctaUrl}" style="display:inline-block;padding:12px 20px;background:#22c55e;color:#fff;border-radius:6px;text-decoration:none;font-weight:700">${escape(ctaLabel)}</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e5e7ec;font-size:12px;color:#8a93a6">
          You're receiving this because you have an account on BinGo Auctions.
          <a href="${APP_URL}/profile" style="color:#8a93a6">Manage notifications</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function lotCodeMarkup(code: string): string {
  return `<span style="font-family:monospace;color:#22c55e;font-weight:700">${escape(code)}</span>`;
}

// " for lot X" / " for lots X and Y" / " for 3 lots: X, Y, Z". Falls back to
// the single payload lot_code when the invoice's lots couldn't be loaded.
export function receiptLotsPhrase(lotCodes: unknown, lotCode: string | null): string {
  const codes = Array.isArray(lotCodes)
    ? lotCodes.filter((c): c is string => typeof c === 'string')
    : [];
  if (codes.length === 0) return lotCode ? ` for lot ${lotCodeMarkup(lotCode)}` : '';
  const [first, second] = codes;
  if (codes.length === 1 && first) return ` for lot ${lotCodeMarkup(first)}`;
  if (codes.length === 2 && first && second) {
    return ` for lots ${lotCodeMarkup(first)} and ${lotCodeMarkup(second)}`;
  }
  return ` for ${codes.length} lots: ${codes.map(lotCodeMarkup).join(', ')}`;
}

function buildEmail(
  row: OutboxRow,
  offsite: OffsiteNotificationCopy | null = null,
): EmailContent | null {
  const built = buildEmailHtml(row, offsite);
  if (!built) return null;
  return { ...built, text: htmlToText(built.html) };
}

export function buildEmailHtml(
  row: OutboxRow,
  offsite: OffsiteNotificationCopy | null = null,
): { subject: string; html: string } | null {
  const lotTitle = (row.payload['lot_title'] as string | undefined) ?? 'a lot';
  const lotId = (row.payload['lot_id'] as string | undefined) ?? null;
  const invoiceId = (row.payload['invoice_id'] as string | undefined) ?? null;
  const lotLink = lotId ? `${APP_URL}/lot/${lotId}` : APP_URL;
  const invoiceLink = invoiceId ? `${APP_URL}/invoice/${invoiceId}` : APP_URL;
  const lotCode =
    typeof row.payload['lot_code'] === 'string' ? row.payload['lot_code'] : null;
  const codeMarkup = lotCode
    ? ` <span style="font-family:monospace;color:#22c55e;font-weight:700">${escape(lotCode)}</span>`
    : '';
  const codeBracketed = lotCode ? ` (${lotCode})` : '';

  switch (row.kind) {
    case 'outbid': {
      // Shared copy — see @auction-platform/shared/notification-copy. Email is
      // the only channel that carries OUTBID_TIE_RULE, because it is the only
      // one with room and because the tie rule is what the BIN-016617 customer
      // could not have known. It goes on EVERY outbid email, not only ties: a
      // bidder who learns the rule before they tie is better off than one who
      // has it explained afterwards.
      const bid = fmtCents(row.payload['current_bid_cents']);
      const body = escape(outbidBody({ lotTitle, lotCode, price: bid }));
      return {
        subject: `${OUTBID_HEADLINE} — ${lotTitle}${codeBracketed}`,
        html: wrap(
          OUTBID_HEADLINE,
          `${body}<br><br><em style="color:#666">${escape(OUTBID_TIE_RULE)}</em>`,
          'Bid again',
          lotLink,
        ),
      };
    }
    case 'won': {
      const win = fmtCents(row.payload['winning_bid_cents']);
      // Post-win referral pitch — a winner mid-celebration is the most
      // likely sharer the platform ever sees.
      const refCode =
        typeof row.payload['referral_code'] === 'string'
          ? (row.payload['referral_code'] as string)
          : null;
      const bragLine = refCode
        ? ` Scored a deal? Tell a friend — share your code <strong style="font-family:monospace">${escape(refCode)}</strong> (<a href="${APP_URL}/signup?ref=${encodeURIComponent(refCode)}" style="color:#16a34a">${APP_URL}/signup?ref=${escape(refCode)}</a>) and you both get $5 off.`
        : '';
      return {
        subject: win
          ? `🏆 You won "${lotTitle}"${codeBracketed} for ${win}`
          : `🏆 You won "${lotTitle}"${codeBracketed}`,
        html: wrap(
          win ? `You won ${escape(lotTitle)} for ${win}` : 'You won!',
          // Same false promise as payment_succeeded below — no pickup_ready
          // text is ever sent. Direct winners to the posted window instead.
          appendOffsiteEmailBlock(
            `${lotCode ? `Lot${codeMarkup}. ` : ''}Pay your invoice, then collect during the pickup window posted for this auction — your pickup pass in the app shows the window and where each item is.${bragLine}`,
            offsite,
          ),
          'Pay invoice',
          invoiceLink,
        ),
      };
    }
    case 'payment_succeeded': {
      const amount = fmtCents(row.payload['amount_cents']);
      return {
        subject: amount ? `Payment received: ${amount}` : 'Payment received',
        html: wrap(
          amount ? `Payment received: ${amount}` : 'Payment received',
          // 2026-08-05: this used to promise "we'll let you know when your
          // items are staged for pickup". That notice is `pickup_ready`,
          // which only assign_lot_to_bin enqueues once EVERY lot on the
          // invoice has a 'staged' bin_assignment (mig 0147). BinGo hands
          // items over straight off the intake shelf and has never used the
          // staging step — `bin_assignments` is empty in prod and
          // `pickup_ready` has fired exactly zero times. So customers waited
          // for a message that could not arrive, missed the window, and
          // `pickup_no_show_forfeit` fired on them instead (182 times).
          // Point at the posted window; promise nothing we don't send.
          appendOffsiteEmailBlock(
            `Your payment${receiptLotsPhrase(row.payload['lot_codes'], lotCode)}${amount ? ` of <strong>${amount}</strong>` : ''} was processed. Your receipt is available any time from your profile. <strong>Pick up your items during the pickup window posted for this auction</strong> — there's no separate "ready for pickup" message to wait for. Your pickup pass in the app shows the window and where each item is.`,
            offsite,
          ),
          'View receipt',
          invoiceLink,
        ),
      };
    }
    case 'add_card_nudge':
      return {
        subject: "You're one step from bidding on BinGo",
        html: wrap(
          "You're one step from bidding",
          `Your BinGo Auctions account is ready — the only thing missing is a card on file. Add one now and you can bid on hundreds of lots closing this week. Your card is <strong>only charged if you win</strong>.`,
          'Add a card',
          `${APP_URL}/bidder/onboarding/payment-method`,
        ),
      };
    case 'onboarding_nudge':
      return {
        subject: 'Finish setting up your BinGo Auctions account',
        html: wrap(
          'You’re almost in',
          `You created a BinGo Auctions login but didn’t finish setting up your bidder account — it takes about a minute, and then you can bid on lots closing this week. Everything sells at auction prices with local pickup, and your card is <strong>only charged if you win</strong>.`,
          'Finish my account',
          `${APP_URL}/bidder/onboarding`,
        ),
      };
    case 'card_fix_notice':
      return {
        subject: 'Fixed: saving your card works now',
        html: wrap(
          'Sorry about that — it’s fixed',
          `Some new bidders saw <em>“We couldn’t save that card”</em> no matter which card they tried. That was a bug on our side (nothing wrong with your card), and it’s fixed. If you hit it, please try adding your card again — it takes a few seconds, and you’re only ever charged when you win.`,
          'Add my card',
          `${APP_URL}/bidder/onboarding/payment-method`,
        ),
      };
    case 'referral_credited': {
      const amount = fmtCents(row.payload['amount_cents']) ?? '$5';
      const isReferrer = row.payload['role'] === 'referrer';
      return {
        subject: `You earned ${amount} in BinGo credit 🎉`,
        html: wrap(
          `You earned ${amount} in credit`,
          isReferrer
            ? `Your friend joined through your code and picked up their first win. <strong>${amount}</strong> comes off your next invoice automatically — nothing to redeem. Keep sharing your code from your profile to earn more.`
            : `Thanks for joining through a friend! <strong>${amount}</strong> comes off your next invoice automatically — nothing to redeem. You have a code of your own now too: share it and you both get ${amount} again.`,
          'View my credit',
          `${APP_URL}/profile`,
        ),
      };
    }
    case 'loyalty_announcement': {
      const unsubUrl = `${APP_URL}/api/email/unsubscribe?b=${encodeURIComponent(row.target_user_id)}&sig=${unsubscribeSig(row.target_user_id)}`;
      const html = `<!doctype html>
<html><head><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e5e7ec;max-width:560px">
        <tr><td style="padding:32px">
          <h1 style="font-size:24px;margin:0 0 12px">Your store loyalty points now work at BinGo Auctions 🎉</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#46505f">
            Big news for loyalty members — the points you earn at our stores and the points
            you earn winning auctions are now <strong>one balance</strong>:
          </p>
          <ul style="font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px;color:#46505f">
            <li><strong>Every auction win earns points</strong>, same as spending in store</li>
            <li><strong>Redeem points for auction credit</strong> right from your profile — it applies to your next win automatically</li>
            <li>Same points, same balance — spend them at the register or on bingoauctions.com</li>
          </ul>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#46505f">
            <strong>One step to link it up:</strong> add the phone number on your loyalty account
            to your BinGo profile — that&rsquo;s how your points find you (same as giving your
            number at the register).
          </p>
          <p style="text-align:center;margin:0 0 16px">
            <a href="${APP_URL}/profile" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#fff;border-radius:6px;text-decoration:none;font-weight:700">Add my phone &amp; see my points</a>
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0;color:#8a93a6;text-align:center">
            Don&rsquo;t have points yet? Every dollar spent — in store or at auction — starts earning them.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e5e7ec;font-size:12px;color:#8a93a6;text-align:center">
          BinGo Auctions · You're receiving this because you have a BinGo Auctions account.<br>
          <a href="${unsubUrl}" style="color:#8a93a6">Unsubscribe from marketing emails</a> (win, receipt &amp; pickup emails are unaffected).
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
      return { subject: 'Your store loyalty points now work at BinGo Auctions 🎉', html };
    }
    case 'referral_announcement': {
      const code = typeof row.payload['referral_code'] === 'string' ? (row.payload['referral_code'] as string) : null;
      if (!code) return null;
      const shareUrl = `${APP_URL}/signup?ref=${encodeURIComponent(code)}`;
      const unsubUrl = `${APP_URL}/api/email/unsubscribe?b=${encodeURIComponent(row.target_user_id)}&sig=${unsubscribeSig(row.target_user_id)}`;
      const html = `<!doctype html>
<html><head><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e5e7ec;max-width:560px">
        <tr><td style="padding:32px;text-align:center">
          <h1 style="font-size:24px;margin:0 0 8px">Give $5, get $5 💚</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 20px;color:#46505f">
            Know someone who loves a deal? Share your personal code. When they sign up
            and pick up their first win, <strong>you both get $5 off</strong> —
            applied to your next invoice automatically.
          </p>
          <div style="display:inline-block;padding:14px 28px;background:#f0fdf4;border:2px dashed #22c55e;border-radius:8px;font-family:monospace;font-size:26px;font-weight:800;letter-spacing:5px;color:#16a34a;margin-bottom:20px">${escape(code)}</div>
          <p style="font-size:13px;color:#46505f;margin:0 0 20px">
            Or just send them this link:<br>
            <a href="${shareUrl}" style="color:#16a34a;font-weight:700">${escape(shareUrl)}</a>
          </p>
          <a href="${APP_URL}/profile" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#fff;border-radius:6px;text-decoration:none;font-weight:700">See my code &amp; credit</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e5e7ec;font-size:12px;color:#8a93a6;text-align:center">
          BinGo Auctions · You're receiving this because you have a BinGo Auctions account.<br>
          <a href="${unsubUrl}" style="color:#8a93a6">Unsubscribe from marketing emails</a> (win, receipt &amp; pickup emails are unaffected).
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
      return { subject: 'Give $5, get $5 — share your BinGo code', html };
    }
    case 'marketing_digest': {
      // Custom layout (lot grid), not the wrap() card. Payload is written by
      // lib/marketing-digest.ts: { subject, lots: DigestLot[] }.
      const subject =
        typeof row.payload['subject'] === 'string'
          ? (row.payload['subject'] as string)
          : 'Ending soon at BinGo Auctions';
      const lots = Array.isArray(row.payload['lots'])
        ? (row.payload['lots'] as Array<{
            lot_code?: string;
            title?: string;
            photo_url?: string | null;
            current_bid_cents?: number | null;
            starting_bid_cents?: number | null;
          }>)
        : [];
      if (lots.length === 0) return null;

      const cards = lots
        .map((l) => {
          const price = fmtCents(l.current_bid_cents) ?? fmtCents(l.starting_bid_cents) ?? '';
          const label = typeof l.current_bid_cents === 'number' ? 'Current bid' : 'Starting at';
          const href = `${APP_URL}/lot/${encodeURIComponent(l.lot_code ?? '')}?utm_source=digest&utm_medium=email`;
          const img = l.photo_url
            ? `<img src="${escape(cdnImageUrl(l.photo_url, { absolute: true }))}" alt="" width="100%" style="display:block;width:100%;height:160px;object-fit:cover;border-radius:6px 6px 0 0;background:#eef0f3">`
            : '';
          return `<td width="50%" style="padding:6px;vertical-align:top">
            <a href="${href}" style="text-decoration:none;color:#0b0d12">
              <div style="border:1px solid #e5e7ec;border-radius:6px;overflow:hidden;background:#fff">
                ${img}
                <div style="padding:10px 12px">
                  <div style="font-size:13px;font-weight:700;line-height:1.3;max-height:2.6em;overflow:hidden">${escape(l.title ?? 'Lot')}</div>
                  <div style="font-size:13px;color:#16a34a;font-weight:800;margin-top:4px">${price} <span style="color:#8a93a6;font-weight:400;font-size:11px">${label}</span></div>
                </div>
              </div>
            </a>
          </td>`;
        })
        .reduce<string[]>((rows2, cell, i) => {
          if (i % 2 === 0) rows2.push(`<tr>${cell}`);
          else rows2[rows2.length - 1] += `${cell}</tr>`;
          return rows2;
        }, [])
        .map((r2) => (r2.endsWith('</tr>') ? r2 : `${r2}<td width="50%" style="padding:6px"></td></tr>`))
        .join('');

      const unsubUrl = `${APP_URL}/api/email/unsubscribe?b=${encodeURIComponent(row.target_user_id)}&sig=${unsubscribeSig(row.target_user_id)}`;
      const html = `<!doctype html>
<html><head><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
        <tr><td style="padding:0 6px 12px">
          <h1 style="font-size:22px;margin:0 0 4px">${escape(subject)}</h1>
          <p style="font-size:14px;color:#46505f;margin:0">Bid before they're gone — pickup is local and easy.</p>
        </td></tr>
        ${cards}
        <tr><td colspan="2" align="center" style="padding:18px 6px">
          <a href="${APP_URL}/browse?utm_source=digest&utm_medium=email" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#fff;border-radius:6px;text-decoration:none;font-weight:700">See everything closing</a>
        </td></tr>
        <tr><td colspan="2" style="padding:12px 6px;font-size:12px;color:#8a93a6;text-align:center">
          BinGo Auctions · You're receiving this because you have a BinGo Auctions account.<br>
          <a href="${unsubUrl}" style="color:#8a93a6">Unsubscribe from marketing emails</a> (win, receipt &amp; pickup emails are unaffected).
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
      return { subject, html };
    }
    case 'marketing_campaign': {
      // Mig 0292 segmented campaigns. Same lot-grid layout as marketing_digest,
      // but every string comes from the campaign ROW (subject/headline/subcopy/
      // CTA) so the owner can retune copy in /marketing without a deploy.
      // Payload is written by lib/marketing-campaigns.ts.
      const subject =
        typeof row.payload['subject'] === 'string'
          ? (row.payload['subject'] as string)
          : 'BinGo Auctions';
      const headline =
        typeof row.payload['headline'] === 'string' ? (row.payload['headline'] as string) : subject;
      const subcopy = typeof row.payload['subcopy'] === 'string' ? (row.payload['subcopy'] as string) : '';
      const ctaLabel =
        typeof row.payload['cta_label'] === 'string'
          ? (row.payload['cta_label'] as string)
          : 'Browse auctions';
      const ctaPath =
        typeof row.payload['cta_path'] === 'string' ? (row.payload['cta_path'] as string) : '/browse';
      const slug =
        typeof row.payload['campaign_slug'] === 'string'
          ? (row.payload['campaign_slug'] as string)
          : 'campaign';
      const lots = Array.isArray(row.payload['lots'])
        ? (row.payload['lots'] as Array<{
            lot_code?: string;
            title?: string;
            photo_url?: string | null;
            current_bid_cents?: number | null;
            starting_bid_cents?: number | null;
          }>)
        : [];

      // utm_campaign carries the slug so Square/GA can separate the campaigns.
      const utm = `utm_source=campaign&utm_medium=email&utm_campaign=${encodeURIComponent(slug)}`;

      // A lotless campaign (e.g. sms_optin_push) is legitimate — it renders as
      // copy + CTA with no grid, rather than being dropped like the digest.
      const cards = lots
        .map((l) => {
          const price = fmtCents(l.current_bid_cents) ?? fmtCents(l.starting_bid_cents) ?? '';
          const label = typeof l.current_bid_cents === 'number' ? 'Current bid' : 'Starting at';
          const href = `${APP_URL}/lot/${encodeURIComponent(l.lot_code ?? '')}?${utm}`;
          const img = l.photo_url
            ? `<img src="${escape(cdnImageUrl(l.photo_url, { absolute: true }))}" alt="" width="100%" style="display:block;width:100%;height:160px;object-fit:cover;border-radius:6px 6px 0 0;background:#eef0f3">`
            : '';
          return `<td width="50%" style="padding:6px;vertical-align:top">
            <a href="${href}" style="text-decoration:none;color:#0b0d12">
              <div style="border:1px solid #e5e7ec;border-radius:6px;overflow:hidden;background:#fff">
                ${img}
                <div style="padding:10px 12px">
                  <div style="font-size:13px;font-weight:700;line-height:1.3;max-height:2.6em;overflow:hidden">${escape(l.title ?? 'Lot')}</div>
                  <div style="font-size:13px;color:#16a34a;font-weight:800;margin-top:4px">${price} <span style="color:#8a93a6;font-weight:400;font-size:11px">${label}</span></div>
                </div>
              </div>
            </a>
          </td>`;
        })
        .reduce<string[]>((rows2, cell, i) => {
          if (i % 2 === 0) rows2.push(`<tr>${cell}`);
          else rows2[rows2.length - 1] += `${cell}</tr>`;
          return rows2;
        }, [])
        .map((r2) => (r2.endsWith('</tr>') ? r2 : `${r2}<td width="50%" style="padding:6px"></td></tr>`))
        .join('');

      const unsubUrl = `${APP_URL}/api/email/unsubscribe?b=${encodeURIComponent(row.target_user_id)}&sig=${unsubscribeSig(row.target_user_id)}`;
      const html = `<!doctype html>
<html><head><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
        <tr><td style="padding:0 6px 12px">
          <h1 style="font-size:22px;margin:0 0 6px">${escape(headline)}</h1>
          ${subcopy ? `<p style="font-size:14px;color:#46505f;margin:0;line-height:1.5">${escape(subcopy)}</p>` : ''}
        </td></tr>
        ${cards}
        <tr><td colspan="2" align="center" style="padding:18px 6px">
          <a href="${APP_URL}${escape(ctaPath)}?${utm}" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#fff;border-radius:6px;text-decoration:none;font-weight:700">${escape(ctaLabel)}</a>
        </td></tr>
        <tr><td colspan="2" style="padding:12px 6px;font-size:12px;color:#8a93a6;text-align:center">
          BinGo Auctions · You're receiving this because you have a BinGo Auctions account.<br>
          <a href="${unsubUrl}" style="color:#8a93a6">Unsubscribe from marketing emails</a> (win, receipt &amp; pickup emails are unaffected).
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
      return { subject, html };
    }
    case 'pickup_ready':
      return {
        subject: `Your items are ready for pickup`,
        html: wrap(
          'Ready for pickup',
          appendOffsiteEmailBlock(
            'All your items have been staged at the warehouse. Open the app to see the pickup map and schedule your visit.',
            offsite,
          ),
          'See pickup map',
          invoiceLink,
        ),
      };
    case 'pickup_confirmed':
      return {
        subject: 'Pickup confirmed',
        html: wrap(
          'Pickup confirmed',
          // Audit C6 (2026-05-18): the dispute window is 48 hours from
          // pickup per the Bidder Agreement and Operator Terms. Earlier
          // copy said "within 7 days" which contradicted the legal text.
          'Thanks — your items are checked out. If anything looked wrong, you can report a problem from the pickup screen within 48 hours of pickup.',
          'Open app',
          APP_URL,
        ),
      };
    case 'dispute_update':
      return {
        subject: 'Dispute update',
        html: wrap(
          'Dispute update',
          (row.payload['message'] as string | undefined) ?? 'Your dispute was updated.',
          'View dispute',
          APP_URL,
        ),
      };
    case 'closing_soon': {
      const closeAt = row.payload['close_at'] as string | undefined;
      const minutes =
        closeAt && new Date(closeAt).getTime() > Date.now()
          ? Math.max(0, Math.round((new Date(closeAt).getTime() - Date.now()) / 60_000))
          : 10;
      return {
        subject: `"${lotTitle}" closes in ${minutes} min`,
        html: wrap(
          `Closing in ${minutes} min`,
          `<strong>${escape(lotTitle)}</strong> is on your watchlist and is closing soon. Place a bid before someone else does.`,
          'Place bid',
          lotLink,
        ),
      };
    }
    case 'saved_search_hit': {
      const searchName =
        (row.payload['saved_search_name'] as string | undefined) ?? 'your search';
      return {
        subject: `New match for "${searchName}": ${lotTitle}`,
        html: wrap(
          `New match for "${escape(searchName)}"`,
          `<strong>${escape(lotTitle)}</strong> just listed and matches your saved search. Bid before someone else does — or mute the search from your profile if you've moved on.`,
          'View lot',
          lotLink,
        ),
      };
    }
    // ── Audit C5 (2026-05-18): AI budget notifications target operator
    // admins, not bidders. Email content reflects the operator-facing
    // language ("your monthly AI budget") and links into the billing/ai
    // page rather than a lot.
    case 'ai_budget_50':
    case 'ai_budget_80':
    case 'ai_budget_100': {
      const title = (row.payload['title'] as string | undefined) ?? 'AI usage update';
      const body =
        (row.payload['body'] as string | undefined) ??
        "You've reached an AI usage threshold for the month.";
      const billingUrl = `${APP_URL}/billing/ai`;
      return {
        subject: title,
        html: wrap(
          title,
          `${escape(body)}<br/><br/>Review usage and adjust your cap in the AI usage dashboard.`,
          'Open AI usage',
          billingUrl,
        ),
      };
    }
    // STRIPE-P1-1 (2026-05-24 audit): payout event emails. Target is an
    // operator admin/manager. Link to the /payouts dashboard.
    case 'payout_failed': {
      const amt = fmtCents(row.payload['amount_cents']);
      const reason =
        (row.payload['failure_message'] as string | undefined) ?? 'unknown reason';
      const payoutsUrl = `${APP_URL}/payouts`;
      return {
        subject: amt ? `Payout of ${amt} failed` : 'A payout failed',
        html: wrap(
          'Payout failed',
          amt
            ? `A payout of <strong>${amt}</strong> to your bank account failed: <em>${escape(reason)}</em>. Check your bank details in the Payouts dashboard.`
            : `A payout to your bank account failed: <em>${escape(reason)}</em>. Check your bank details in the Payouts dashboard.`,
          'View payouts',
          payoutsUrl,
        ),
      };
    }
    case 'payout_paid': {
      const amt = fmtCents(row.payload['amount_cents']);
      const arrivalDate = row.payload['arrival_date'] as string | undefined;
      const arrivalStr = arrivalDate
        ? ` on ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: DEFAULT_TIME_ZONE }).format(new Date(arrivalDate))}`
        : '';
      const payoutsUrl = `${APP_URL}/payouts`;
      return {
        subject: amt ? `Payout of ${amt} sent` : 'Payout sent',
        html: wrap(
          amt ? `Payout of ${amt} sent` : 'Payout sent',
          `Your payout${arrivalStr} has been sent to your bank account. Funds typically arrive within 2 business days.`,
          'View payouts',
          payoutsUrl,
        ),
      };
    }
    // Dispute opened — operator notification.
    case 'dispute_opened': {
      const disputeAmt = fmtCents(row.payload['amount_cents']);
      const reason = (row.payload['reason'] as string | undefined) ?? 'unspecified';
      const payoutsUrl = `${APP_URL}/payouts`;
      return {
        subject: disputeAmt
          ? `Dispute opened for ${disputeAmt}`
          : 'A new dispute was opened',
        html: wrap(
          'Dispute opened',
          disputeAmt
            ? `A customer has disputed a charge of <strong>${disputeAmt}</strong> (reason: <em>${escape(reason)}</em>). Submit evidence in Stripe within the deadline to contest it.`
            : `A customer has opened a dispute (reason: <em>${escape(reason)}</em>). Submit evidence in Stripe within the deadline to contest it.`,
          'View payouts',
          payoutsUrl,
        ),
      };
    }
    // Payment failed — bidder notification.
    case 'payment_failed': {
      const piInvoiceId = (row.payload['invoice_id'] as string | undefined) ?? null;
      const piInvoiceLink = piInvoiceId ? `${APP_URL}/invoice/${piInvoiceId}` : APP_URL;
      return {
        subject: 'Your payment failed',
        html: wrap(
          'Payment failed',
          'We were unable to charge your card. Update your payment method within 48 hours to keep your lots.',
          'Update payment method',
          piInvoiceLink,
        ),
      };
    }
    // 2026-07-04 prod incident: a kind with no template here made buildEmail
    // return undefined → TypeError OUTSIDE the send loop's try → the whole
    // drain 500'd and the queue wedged behind the oldest bad row (13 emails
    // stuck, zero attempt marks). Unknown kinds now skip cleanly; push
    // delivery for them is unaffected.
    default:
      return null;
  }
}

export type EmailDrainResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

export async function runEmailDrain(): Promise<EmailDrainResult> {
  const resend = getResend();
  if (!resend) return { scanned: 0, sent: 0, skipped: 0, failed: 0 };

  const supabase = getSupabaseAdmin();

  const { data: rows } = await supabase
    .from('notifications_outbox')
    .select('id, kind, target_user_id, payload, email_attempt_count')
    .is('emailed_at', null)
    .lt('email_attempt_count', MAX_ATTEMPTS)
    .order('created_at')
    .limit(BATCH_SIZE)
    .returns<OutboxRow[]>();

  if (!rows || rows.length === 0) {
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  // Quota saver (lib/email-quota): past 90% of the monthly Resend cap, send
  // only win / payment / pickup email. Counted only when this batch holds a
  // non-essential row. If the count fails, send normally (fail open): a
  // missed saver costs a little quota, a wrong saver drops real email.
  let quotaSaver = false;
  if (rows.some((r) => !isEssentialEmailKind(r.kind))) {
    const cfg = quotaConfig(process.env);
    const { count, error: countErr } = await supabase
      .from('notifications_outbox')
      .select('id', { count: 'exact', head: true })
      .gte('emailed_at', cycleStart(new Date(), cfg.cycleDay, cfg.cycleHourUtc).toISOString())
      .is('last_email_error', null);
    if (countErr) {
      console.warn('[email-drain] quota count failed; sending normally:', countErr.message);
    } else {
      quotaSaver = saverOn(count ?? 0, cfg.cap, cfg.saverPct);
      if (quotaSaver) {
        console.warn(`[email-drain] quota saver ON: ${count} of ${cfg.cap} sent this cycle; essential email only`);
      }
    }
  }

  const targetIds = Array.from(new Set(rows.map((r) => r.target_user_id)));
  const { data: bidders } = await supabase
    .from('bidders')
    .select('id, email, email_enabled, referral_code')
    .in('id', targetIds);

  // Post-win share prompt (mig 0232 batch): decorate 'won' rows with the
  // winner's referral code so the template can append the Give $5/get $5
  // brag line — same decoration pattern as lot_code below.
  {
    const codeById = new Map(
      (bidders ?? []).map((b) => [b.id as string, (b.referral_code as string | null) ?? null]),
    );
    for (const row of rows) {
      if (row.kind === 'won') {
        const code = codeById.get(row.target_user_id);
        if (code) row.payload['referral_code'] = code;
      }
    }
  }

  // Audit C5 (2026-05-18): notifications_outbox is shared between bidder
  // and operator audiences (e.g. AI budget alerts target operator admins,
  // not bidders). The original lookup only joined `bidders`, which meant
  // operator-targeted rows silently never received an email. Look up
  // operator_users too and merge; for any user_id present in both tables
  // (an operator admin who is also a bidder), the bidder row wins so we
  // respect their email_enabled preference.
  const { data: operatorRecipients } = await supabase
    .from('operator_users')
    .select('user_id, email')
    .in('user_id', targetIds);

  // Decorate with lot_code.
  const lotIds = Array.from(
    new Set(rows.map((r) => r.payload['lot_id']).filter((v): v is string => typeof v === 'string')),
  );
  if (lotIds.length > 0) {
    // display_code (mig 0315) is the label physically on the box — for a relist
    // child the internal lot_code is a synthetic BIN-###### printed nowhere, so
    // an email naming it sends the customer looking for a code that isn't there.
    const { data: lotRows } = await supabase
      .from('lots')
      .select('id, lot_code, display_code')
      .in('id', lotIds);
    const lotCodeById = new Map(
      ((lotRows ?? []) as Array<{ id: string; lot_code: string; display_code: string | null }>).map(
        (l) => [l.id, l.display_code ?? l.lot_code],
      ),
    );
    for (const row of rows) {
      const lid = row.payload['lot_id'];
      if (typeof lid === 'string') {
        const code = lotCodeById.get(lid);
        if (code) row.payload['lot_code'] = code;
      }
    }
  }

  // A receipt covers the whole invoice, but its payload carries only the
  // invoice's primary lot code — a 2-lot payment read "for lot BIN-031448"
  // and the customer couldn't tell what the other half of the charge was
  // (2026-10-13). Name every lot on the invoice.
  const receiptInvoiceIds = Array.from(
    new Set(
      rows
        .filter((r) => r.kind === 'payment_succeeded')
        .map((r) => r.payload['invoice_id'])
        .filter((v): v is string => typeof v === 'string'),
    ),
  );
  if (receiptInvoiceIds.length > 0) {
    const { data: invoiceLotRows } = await supabase
      .from('invoice_lots')
      .select('invoice_id, lots(lot_code, display_code)')
      .in('invoice_id', receiptInvoiceIds);
    const codesByInvoiceId = new Map<string, string[]>();
    for (const il of (invoiceLotRows ?? []) as unknown as Array<{
      invoice_id: string;
      lots: { lot_code: string; display_code: string | null } | null;
    }>) {
      const code = il.lots ? (il.lots.display_code ?? il.lots.lot_code) : null;
      if (!code) continue;
      const codes = codesByInvoiceId.get(il.invoice_id) ?? [];
      codes.push(code);
      codesByInvoiceId.set(il.invoice_id, codes);
    }
    for (const row of rows) {
      const iid = row.payload['invoice_id'];
      if (row.kind !== 'payment_succeeded' || typeof iid !== 'string') continue;
      const codes = codesByInvoiceId.get(iid);
      if (codes && codes.length > 0) row.payload['lot_codes'] = codes.sort();
    }
  }

  const offsiteByInvoiceId = await loadOffsiteNotificationCopyByInvoiceId(
    supabase,
    invoiceIdsForOffsiteLoad(rows),
  );

  const recipientById = new Map<string, { email: string | null; enabled: boolean }>(
    (bidders ?? []).map((b) => [
      b.id as string,
      {
        email: (b.email as string | null) ?? null,
        enabled: (b.email_enabled as boolean | null) ?? true,
      },
    ]),
  );
  // Audit C5: layer operator_users on top of the bidder map. We only
  // INSERT if the user_id isn't already present as a bidder — bidder
  // email preferences (email_enabled) win for users who are both. There
  // is no per-staff email_enabled flag today; operator-account email is
  // assumed always-on because it's transactional (budget alerts, etc.).
  for (const op of operatorRecipients ?? []) {
    const uid = op.user_id as string;
    if (recipientById.has(uid)) continue;
    recipientById.set(uid, {
      email: (op.email as string | null) ?? null,
      enabled: true,
    });
  }

  const sentIds: string[] = [];
  const skippedIds: Array<{ id: string; reason: string }> = [];
  const failedIds: Array<{ id: string; attempts: number; err: string }> = [];

  for (const row of rows) {
    if (quotaSaver && !isEssentialEmailKind(row.kind)) {
      skippedIds.push({ id: row.id, reason: SAVER_SKIP_REASON });
      continue;
    }
    let b = recipientById.get(row.target_user_id);
    // onboarding_nudge targets auth users with NO bidders/operator_users row
    // (that's the whole point of the nudge) — the sweep stashes their email
    // in the payload. Only this kind may use it: everything else must keep
    // resolving through the tables so email_enabled is respected.
    if (!b?.email && row.kind === 'onboarding_nudge') {
      const payloadEmail = row.payload['email'];
      if (typeof payloadEmail === 'string' && payloadEmail.includes('@')) {
        b = { email: payloadEmail, enabled: true };
      }
    }
    if (!b?.email) {
      skippedIds.push({ id: row.id, reason: 'no_email' });
      continue;
    }
    if (!b.enabled) {
      skippedIds.push({ id: row.id, reason: 'email_disabled' });
      continue;
    }
    const content = buildEmail(row, offsiteCopyForRow(row, offsiteByInvoiceId));
    if (!content) {
      // No email template for this kind (push-only notification). Mark it
      // so it stops blocking the queue; the push drain handles delivery.
      skippedIds.push({ id: row.id, reason: `no_email_template:${row.kind}` });
      continue;
    }
    try {
      const result = await resend.emails.send({
        from: FROM,
        to: b.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      if (result.error) throw new Error(result.error.message);
      sentIds.push(row.id);
    } catch (err) {
      failedIds.push({
        id: row.id,
        attempts: row.email_attempt_count + 1,
        err: (err as Error).message,
      });
    }
  }

  if (sentIds.length > 0) {
    await supabase
      .from('notifications_outbox')
      .update({ emailed_at: new Date().toISOString() })
      .in('id', sentIds);
  }
  for (const s of skippedIds) {
    await supabase
      .from('notifications_outbox')
      .update({ emailed_at: new Date().toISOString(), last_email_error: s.reason })
      .eq('id', s.id);
  }
  for (const f of failedIds) {
    await supabase
      .from('notifications_outbox')
      .update({ email_attempt_count: f.attempts, last_email_error: f.err.slice(0, 500) })
      .eq('id', f.id);
  }

  return {
    scanned: rows.length,
    sent: sentIds.length,
    skipped: skippedIds.length,
    failed: failedIds.length,
  };
}
