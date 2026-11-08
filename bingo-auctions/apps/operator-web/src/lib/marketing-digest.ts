// marketing-digest.ts — the "closing soon" marketing email (mig 0230).
//
// Owner wanted dashboard control + automation gentler than nightly, so this
// module exposes exactly two entry points:
//
//   enqueueDigest({sentBy})       what the console "Send now" button calls
//   runMarketingDigestAuto()      what the daily cron calls; it self-gates:
//                                   1. platform_settings.digest_auto_enabled
//                                   2. lots actually close within 24h
//                                   3. last digest is > 72h old
//                                 Any gate fails → no email. Content-driven,
//                                 max ~2/week, never a "nothing new" blast.
//
// Delivery: one notifications_outbox row per opted-in bidder (kind
// 'marketing_digest', payload carries the rendered lot list). The email
// drain does batching/retries; the push drain skips this kind — email only.
// Idempotency: 'digest:{send_id}:{bidder_id}' outbox keys, so a crashed
// enqueue re-run can't double-send within the same digest.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const MANUAL_WINDOW_HOURS = 48;
export const AUTO_WINDOW_HOURS = 24;
export const DEFAULT_LOT_COUNT = 12;
export const MIN_HOURS_BETWEEN_AUTO = 72;

/** Dashboard-configurable featured-lot count (mig 0231, 1–24, default 12). */
export async function getDigestLotCount(admin: SupabaseClient): Promise<number> {
  const { data } = await admin
    .from('platform_settings')
    .select('digest_lot_count')
    .eq('id', true)
    .maybeSingle();
  const n = (data as { digest_lot_count?: number } | null)?.digest_lot_count;
  return typeof n === 'number' && n >= 1 && n <= 24 ? n : DEFAULT_LOT_COUNT;
}

export type DigestLot = {
  lot_code: string;
  title: string;
  photo_url: string | null;
  current_bid_cents: number | null;
  starting_bid_cents: number | null;
  close_at: string | null;
};

export async function selectDigestLots(
  admin: SupabaseClient,
  windowHours: number,
  maxLots: number,
): Promise<DigestLot[]> {
  const { data, error } = await admin
    .from('lots')
    // 0242: !inner join drops lots in unlisted (link-only) test auctions —
    // they must never appear in marketing emails.
    .select('lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, auctions!inner(unlisted)')
    .eq('status', 'live')
    .eq('auctions.unlisted', false)
    .not('close_at', 'is', null)
    .gte('close_at', new Date().toISOString())
    .lte('close_at', new Date(Date.now() + windowHours * 3600_000).toISOString())
    // Most bid action first — the liveliest lots make the best hook.
    .order('current_bid_cents', { ascending: false, nullsFirst: false })
    .limit(maxLots);
  if (error) throw new Error(`digest lot select failed: ${error.message}`);
  return (data ?? []).map((l) => ({
    lot_code: l.lot_code as string,
    title: l.title as string,
    photo_url: Array.isArray(l.photo_urls) ? ((l.photo_urls[0] as string | undefined) ?? null) : null,
    current_bid_cents: (l.current_bid_cents as number | null) ?? null,
    starting_bid_cents: (l.starting_bid_cents as number | null) ?? null,
    close_at: (l.close_at as string | null) ?? null,
  }));
}

export async function countDigestRecipients(admin: SupabaseClient): Promise<number> {
  const { count } = await admin
    .from('bidders')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .not('email', 'is', null)
    .eq('email_enabled', true)
    .eq('marketing_emails_enabled', true);
  return count ?? 0;
}

export type DigestEnqueueResult = {
  sent: boolean;
  reason?: string;
  recipients?: number;
  lots?: number;
};

export async function enqueueDigest(args: {
  sentBy: 'manual' | 'auto';
  windowHours: number;
}): Promise<DigestEnqueueResult> {
  const admin = getSupabaseAdmin();

  const lots = await selectDigestLots(admin, args.windowHours, await getDigestLotCount(admin));
  if (lots.length === 0) return { sent: false, reason: 'no_lots_closing' };

  const { data: recipients, error: recErr } = await admin
    .from('bidders')
    .select('id')
    .is('deleted_at', null)
    .not('email', 'is', null)
    .eq('email_enabled', true)
    .eq('marketing_emails_enabled', true);
  if (recErr) throw new Error(`digest recipient select failed: ${recErr.message}`);
  if (!recipients || recipients.length === 0) return { sent: false, reason: 'no_recipients' };

  const subject =
    lots.length === 1
      ? `Ending soon: ${lots[0]!.title}`
      : `${lots.length} lots ending soon at BinGo Auctions`;

  // Log row first — its id keys the outbox idempotency, so a partial crash
  // resumes into the SAME digest instead of minting a duplicate one.
  const { data: sendRow, error: logErr } = await admin
    .from('marketing_digest_sends')
    .insert({
      sent_by: args.sentBy,
      recipient_count: recipients.length,
      lot_count: lots.length,
      subject,
    })
    .select('id')
    .single();
  if (logErr || !sendRow) throw new Error(`digest log insert failed: ${logErr?.message}`);

  const payload = { subject, lots };
  // Chunked inserts keep each statement bounded (159 today, but signups grow).
  const CHUNK = 100;
  for (let i = 0; i < recipients.length; i += CHUNK) {
    const rows = recipients.slice(i, i + CHUNK).map((r) => ({
      target_user_id: r.id,
      kind: 'marketing_digest',
      idempotency_key: `digest:${sendRow.id}:${r.id}`,
      payload,
    }));
    const { error: insErr } = await admin.from('notifications_outbox').insert(rows);
    if (insErr) {
      // Unique-violation chunks mean a retry overlap — fine. Anything else
      // aborts loudly; the idempotency keys make a re-run safe.
      if (insErr.code !== '23505') throw new Error(`digest outbox insert failed: ${insErr.message}`);
    }
  }

  return { sent: true, recipients: recipients.length, lots: lots.length };
}

/**
 * One-time "Give $5, get $5" announcement (mig 0231) — emails every opted-in
 * bidder their PERSONAL referral code. Once per bidder EVER: the outbox key
 * 'refannounce:{bidder_id}' never changes, so pressing the button again
 * later only reaches bidders who haven't received it (new signups).
 */
export async function enqueueReferralAnnouncement(): Promise<DigestEnqueueResult> {
  const admin = getSupabaseAdmin();

  const { data: recipients, error: recErr } = await admin
    .from('bidders')
    .select('id, referral_code')
    .is('deleted_at', null)
    .not('email', 'is', null)
    .not('referral_code', 'is', null)
    .eq('email_enabled', true)
    .eq('marketing_emails_enabled', true);
  if (recErr) throw new Error(`announcement recipient select failed: ${recErr.message}`);

  // Skip bidders who already got it (any prior press of the button).
  const { data: already } = await admin
    .from('notifications_outbox')
    .select('target_user_id')
    .eq('kind', 'referral_announcement');
  const alreadyIds = new Set((already ?? []).map((r) => r.target_user_id as string));
  const fresh = (recipients ?? []).filter((r) => !alreadyIds.has(r.id as string));
  if (fresh.length === 0) return { sent: false, reason: 'everyone_already_announced' };

  const CHUNK = 100;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const rows = fresh.slice(i, i + CHUNK).map((r) => ({
      target_user_id: r.id,
      kind: 'referral_announcement',
      idempotency_key: `refannounce:${r.id}`,
      payload: { referral_code: r.referral_code },
    }));
    const { error: insErr } = await admin.from('notifications_outbox').insert(rows);
    if (insErr && insErr.code !== '23505') {
      throw new Error(`announcement outbox insert failed: ${insErr.message}`);
    }
  }

  await admin.from('marketing_digest_sends').insert({
    sent_by: 'manual',
    recipient_count: fresh.length,
    lot_count: 0,
    subject: 'Give $5, get $5 — referral program announcement',
  });

  return { sent: true, recipients: fresh.length, lots: 0 };
}

export async function runMarketingDigestAuto(): Promise<DigestEnqueueResult> {
  const admin = getSupabaseAdmin();

  const { data: settings } = await admin
    .from('platform_settings')
    .select('digest_auto_enabled')
    .eq('id', true)
    .maybeSingle();
  if (!settings?.digest_auto_enabled) return { sent: false, reason: 'auto_disabled' };

  const { data: lastSend } = await admin
    .from('marketing_digest_sends')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    lastSend &&
    Date.now() - new Date(lastSend.created_at as string).getTime() <
      MIN_HOURS_BETWEEN_AUTO * 3600_000
  ) {
    return { sent: false, reason: 'rate_limited_72h' };
  }

  return enqueueDigest({ sentBy: 'auto', windowHours: AUTO_WINDOW_HOURS });
}
