// Drains notifications_outbox via Twilio for SMS delivery. Port of
// packages/auction-engine/src/sms.ts. Separate state column (smsed_at,
// sms_attempt_count, last_sms_error) from push/email.
//
// SMS is opt-IN -- bidders.sms_enabled defaults to false. Carrier filters
// get aggressive on unsolicited transactional SMS so we never auto-send
// even if a token is on file.

import twilio from 'twilio';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { outbidSms } from '@auction-platform/shared';
import type { OffsiteNotificationCopy } from '@/lib/offsite-notification-copy';
import {
  invoiceIdsForOffsiteLoad,
  loadOffsiteNotificationCopyByInvoiceId,
  offsiteCopyForRow,
} from '@/lib/notification-offsite-load';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

const FROM = process.env.TWILIO_FROM_PHONE;
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
const APP_URL = process.env.PUBLIC_APP_URL ?? 'https://bingoauctions.com';

let twilioClient: twilio.Twilio | null = null;
function getTwilio(): twilio.Twilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  if (!twilioClient) twilioClient = twilio(sid, token);
  return twilioClient;
}

function shortLink(path: string): string {
  return `${APP_URL}${path}`;
}

function fmtCents(cents: unknown): string | null {
  if (typeof cents !== 'number') return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * The only kinds that may ever go out by SMS — time-sensitive, bidder-initiated,
 * transactional. Derived from `buildSms`'s switch: this array and that switch
 * must stay in lockstep, which the SmsKind type below enforces at compile time.
 */
export const SMS_KINDS = [
  'outbid',
  'won',
  'pickup_ready',
  'pickup_confirmed',
  'dispute_update',
  'closing_soon',
  'saved_search_hit',
] as const;

type SmsKind = (typeof SMS_KINDS)[number];

type OutboxRow = {
  id: string;
  kind: SmsKind;
  target_user_id: string;
  payload: Record<string, unknown>;
  sms_attempt_count: number;
};

function appendOffsiteSms(base: string, offsite: OffsiteNotificationCopy | null): string {
  if (!offsite?.smsLine) return base;
  return `${base} ${offsite.smsLine}`;
}

function buildSms(row: OutboxRow, offsite: OffsiteNotificationCopy | null = null): string {
  const lotTitle = (row.payload['lot_title'] as string | undefined) ?? 'a lot';
  const lotId = (row.payload['lot_id'] as string | undefined) ?? null;
  const invoiceId = (row.payload['invoice_id'] as string | undefined) ?? null;
  const lotCode =
    typeof row.payload['lot_code'] === 'string' ? row.payload['lot_code'] : null;
  const codeBit = lotCode ? ` ${lotCode}` : '';

  switch (row.kind) {
    case 'outbid': {
      // Shared copy — same three things the push and email say (you are not
      // leading, your max is not enough, raise it), compressed. outbidSms
      // trims the title AFTER the link is accounted for, so the link is never
      // what gets cut, and keeps the output GSM-7 so one stray character
      // cannot halve the segment limit from 160 to 70.
      return outbidSms({
        lotTitle,
        lotCode,
        price: fmtCents(row.payload['current_bid_cents']),
        link: shortLink(`/lot/${lotId ?? ''}`),
      });
    }
    case 'won': {
      const win = fmtCents(row.payload['winning_bid_cents']);
      const base = win
        ? `Won${codeBit} "${trim(lotTitle, 38)}" for ${win}. Pay: ${shortLink(`/invoice/${invoiceId ?? ''}`)}`
        : `Won${codeBit} "${trim(lotTitle, 45)}". Pay: ${shortLink(`/invoice/${invoiceId ?? ''}`)}`;
      return appendOffsiteSms(base, offsite);
    }
    case 'pickup_ready':
      return appendOffsiteSms(
        `Your items are staged for pickup. Map: ${shortLink(`/pickup/${invoiceId ?? ''}`)}`,
        offsite,
      );
    case 'pickup_confirmed':
      return `Pickup confirmed. Thanks for using BinGo Auctions.`;
    case 'dispute_update':
      return (
        ((row.payload['message'] as string | undefined) ?? 'Your dispute was updated.') +
        ' ' +
        shortLink('/profile')
      );
    case 'closing_soon': {
      const closeAt = row.payload['close_at'] as string | undefined;
      const minutes =
        closeAt && new Date(closeAt).getTime() > Date.now()
          ? Math.max(0, Math.round((new Date(closeAt).getTime() - Date.now()) / 60_000))
          : 10;
      const lead = minutes <= 2 ? 'Last call' : 'Closing soon';
      return `${lead}: "${trim(lotTitle, 45)}" closes in ${minutes}m. ${shortLink(`/lot/${lotId ?? ''}`)}`;
    }
    case 'saved_search_hit': {
      const searchName = trim(
        (row.payload['saved_search_name'] as string | undefined) ?? 'your search',
        25,
      );
      return `New match for "${searchName}": "${trim(lotTitle, 40)}". ${shortLink(`/lot/${lotId ?? ''}`)}`;
    }
  }
}

export type SmsDrainResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

export async function runSmsDrain(): Promise<SmsDrainResult> {
  const twilioCli = getTwilio();
  if (!twilioCli) return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!FROM && !MESSAGING_SERVICE_SID) {
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const supabase = getSupabaseAdmin();

  const { data: rows } = await supabase
    .from('notifications_outbox')
    .select('id, kind, target_user_id, payload, sms_attempt_count')
    .is('smsed_at', null)
    .lt('sms_attempt_count', MAX_ATTEMPTS)
    // ALLOWLIST, not a denylist (was: `.not('kind','in',(ai_budget_*))`).
    //
    // Two reasons. (1) `buildSms` is an exhaustive switch over exactly these
    // kinds and returns undefined for anything else — which would send Twilio an
    // undefined body, burn all 3 attempts, and mark the row failed. Every kind
    // added since (marketing_digest, referral_announcement, loyalty_announcement,
    // add_card_nudge, onboarding_nudge, payout_*, dispute_opened, payment_*,
    // and marketing_campaign in mig 0292) hits that path. (2) Marketing must
    // never go out by SMS: carriers filter unsolicited promotional traffic hard,
    // and one A2P complaint can take the whole number down — which would kill
    // outbid alerts, the one SMS bidders actually want.
    //
    // An allowlist fails CLOSED: a new kind is silently not-SMS until someone
    // adds a `buildSms` case and lists it here, which is the safe default.
    .in('kind', [...SMS_KINDS])
    .order('created_at')
    .limit(BATCH_SIZE)
    .returns<OutboxRow[]>();

  if (!rows || rows.length === 0) {
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const targetIds = Array.from(new Set(rows.map((r) => r.target_user_id)));
  const { data: bidders } = await supabase
    .from('bidders')
    .select('id, phone, sms_enabled')
    .in('id', targetIds);

  // Decorate with lot_code.
  const lotIds = Array.from(
    new Set(rows.map((r) => r.payload['lot_id']).filter((v): v is string => typeof v === 'string')),
  );
  if (lotIds.length > 0) {
    // display_code (mig 0315) is the label physically on the box — see the same
    // hydration in email-drain.ts.
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

  const offsiteByInvoiceId = await loadOffsiteNotificationCopyByInvoiceId(
    supabase,
    invoiceIdsForOffsiteLoad(rows),
  );

  const bidderById = new Map<string, { phone: string | null; sms_enabled: boolean }>(
    (bidders ?? []).map((b) => [
      b.id as string,
      {
        phone: (b.phone as string | null) ?? null,
        sms_enabled: (b.sms_enabled as boolean | null) ?? false,
      },
    ]),
  );

  const sentIds: string[] = [];
  const skippedIds: Array<{ id: string; reason: string }> = [];
  const failedIds: Array<{ id: string; attempts: number; err: string }> = [];

  for (const row of rows) {
    const b = bidderById.get(row.target_user_id);
    if (!b) {
      skippedIds.push({ id: row.id, reason: 'no_bidder' });
      continue;
    }
    if (!b.sms_enabled || !b.phone) {
      skippedIds.push({ id: row.id, reason: !b.phone ? 'no_phone' : 'sms_disabled' });
      continue;
    }
    try {
      const body = buildSms(row, offsiteCopyForRow(row, offsiteByInvoiceId));
      await twilioCli.messages.create({
        to: b.phone,
        body,
        ...(MESSAGING_SERVICE_SID
          ? { messagingServiceSid: MESSAGING_SERVICE_SID }
          : { from: FROM! }),
      });
      sentIds.push(row.id);
    } catch (err) {
      failedIds.push({
        id: row.id,
        attempts: row.sms_attempt_count + 1,
        err: (err as Error).message,
      });
    }
  }

  if (sentIds.length > 0) {
    await supabase
      .from('notifications_outbox')
      .update({ smsed_at: new Date().toISOString() })
      .in('id', sentIds);
  }
  for (const s of skippedIds) {
    await supabase
      .from('notifications_outbox')
      .update({ smsed_at: new Date().toISOString(), last_sms_error: s.reason })
      .eq('id', s.id);
  }
  for (const f of failedIds) {
    await supabase
      .from('notifications_outbox')
      .update({ sms_attempt_count: f.attempts, last_sms_error: f.err.slice(0, 500) })
      .eq('id', f.id);
  }

  return {
    scanned: rows.length,
    sent: sentIds.length,
    skipped: skippedIds.length,
    failed: failedIds.length,
  };
}
