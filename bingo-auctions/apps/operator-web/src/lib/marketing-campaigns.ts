// marketing-campaigns.ts — the campaign engine (mig 0292).
//
// The closing-soon digest (lib/marketing-digest.ts, mig 0230) speaks to every
// opted-in bidder with the same message. This module adds SEGMENTED recurring
// campaigns on the same rails: a campaign is a ROW in marketing_campaigns
// (audience + lot strategy + copy + cadence), so adding one is an INSERT rather
// than a deploy.
//
// Why these campaigns: measured on prod 2026-07-27, 268 of 627 bidders (43%)
// have never placed a single bid, while only 11 are lapsed. The leak is
// activation, not retention — hence `first_bid_nudge` leading with the cheapest
// live lots, and `outbid_comeback` for the 108 who bid and never won.
//
// Three independent gates, so a campaign can never blast the list:
//   1. campaign.enabled                    — owner switch in /marketing
//   2. min_hours_between_runs               — campaign cadence (checked here)
//   3. cooldown_hours + max_sends_per_bidder — per-person cap, enforced inside
//      campaign_audience() in SQL so this file cannot forget it
// plus max_recipients_per_run as a blast-radius backstop.
//
// Delivery: one notifications_outbox row per recipient, kind
// 'marketing_campaign', drained by lib/cron/email-drain.ts. Idempotency key is
// 'camp:{slug}:{run_id}:{bidder_id}', so a crashed enqueue resumes into the
// SAME run instead of double-sending.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

/** Hours ahead that 'closing_soon' looks. Matches the digest's auto window. */
export const CLOSING_SOON_WINDOW_HOURS = 48;

export type CampaignLotStrategy = 'closing_soon' | 'cheapest' | 'newest' | 'none';

export type Campaign = {
  slug: string;
  name: string;
  description: string;
  audience: string;
  lot_strategy: CampaignLotStrategy;
  lot_count: number;
  subject: string;
  headline: string;
  subcopy: string;
  cta_label: string;
  cta_path: string;
  min_hours_between_runs: number;
  cooldown_hours: number;
  max_sends_per_bidder: number;
  max_recipients_per_run: number;
  enabled: boolean;
};

export type CampaignLot = {
  lot_code: string;
  title: string;
  photo_url: string | null;
  current_bid_cents: number | null;
  starting_bid_cents: number | null;
  close_at: string | null;
};

export type CampaignRunResult = {
  slug: string;
  sent: boolean;
  reason?: string;
  recipients?: number;
  lots?: number;
};

/**
 * Featured lots for a campaign.
 *
 * Every strategy filters on `auctions.unlisted = false` (mig 0242) — lots in
 * link-only test auctions must never appear in marketing. That inner join is
 * load-bearing, not decoration.
 */
export async function selectCampaignLots(
  admin: SupabaseClient,
  strategy: CampaignLotStrategy,
  maxLots: number,
): Promise<CampaignLot[]> {
  if (strategy === 'none' || maxLots <= 0) return [];

  const nowISO = new Date().toISOString();
  let q = admin
    .from('lots')
    .select(
      'lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, auctions!inner(unlisted)',
    )
    .eq('status', 'live')
    .eq('auctions.unlisted', false)
    .not('close_at', 'is', null)
    .gte('close_at', nowISO);

  if (strategy === 'closing_soon') {
    q = q
      .lte('close_at', new Date(Date.now() + CLOSING_SOON_WINDOW_HOURS * 3600_000).toISOString())
      // Most bid action first — the liveliest lots make the best hook.
      .order('current_bid_cents', { ascending: false, nullsFirst: false });
  } else if (strategy === 'cheapest') {
    // Lowest starting bid first. The barrier for a never-bid signup is "am I
    // going to get stuck with something expensive", so lead with $1 lots.
    q = q.order('starting_bid_cents', { ascending: true, nullsFirst: false });
  } else {
    // 'newest' — most recently listed.
    q = q.order('created_at', { ascending: false });
  }

  const { data, error } = await q.limit(maxLots);
  if (error) throw new Error(`campaign lot select failed (${strategy}): ${error.message}`);

  return (data ?? []).map((l) => ({
    lot_code: l.lot_code as string,
    title: l.title as string,
    photo_url: Array.isArray(l.photo_urls) ? ((l.photo_urls[0] as string | undefined) ?? null) : null,
    current_bid_cents: (l.current_bid_cents as number | null) ?? null,
    starting_bid_cents: (l.starting_bid_cents as number | null) ?? null,
    close_at: (l.close_at as string | null) ?? null,
  }));
}

export async function listCampaigns(admin: SupabaseClient): Promise<Campaign[]> {
  const { data, error } = await admin
    .from('marketing_campaigns')
    .select('*')
    .order('enabled', { ascending: false })
    .order('slug');
  if (error) throw new Error(`campaign list failed: ${error.message}`);
  return (data ?? []) as Campaign[];
}

/** Eligible recipients for a campaign, cap-filtered in SQL (mig 0292). */
export async function getCampaignAudience(
  admin: SupabaseClient,
  slug: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await admin.rpc('campaign_audience', { p_slug: slug, p_limit: limit });
  if (error) throw new Error(`campaign audience failed (${slug}): ${error.message}`);
  return ((data ?? []) as Array<{ bidder_id: string }>).map((r) => r.bidder_id);
}

/**
 * Record a run that declined to send, so /marketing can show WHY nothing went
 * out instead of looking broken.
 */
async function logSkip(
  admin: SupabaseClient,
  slug: string,
  trigger: 'auto' | 'manual',
  reason: string,
): Promise<CampaignRunResult> {
  await admin
    .from('marketing_campaign_runs')
    .insert({ campaign_slug: slug, triggered_by: trigger, skipped_reason: reason });
  return { slug, sent: false, reason };
}

/**
 * Run one campaign.
 *
 * `trigger: 'manual'` (the console button) still honours the per-bidder cap and
 * the recipient ceiling — it only bypasses `min_hours_between_runs`, so an owner
 * can send on demand without being able to spam anyone.
 */
export async function runCampaign(
  campaign: Campaign,
  trigger: 'auto' | 'manual',
): Promise<CampaignRunResult> {
  const admin = getSupabaseAdmin();

  if (trigger === 'auto') {
    if (!campaign.enabled) return { slug: campaign.slug, sent: false, reason: 'disabled' };

    // Cadence gate. Only successful runs count — a skipped run must not push
    // the next attempt out by another cycle.
    const { data: lastRun } = await admin
      .from('marketing_campaign_runs')
      .select('created_at')
      .eq('campaign_slug', campaign.slug)
      .is('skipped_reason', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      lastRun &&
      Date.now() - new Date((lastRun as { created_at: string }).created_at).getTime() <
        campaign.min_hours_between_runs * 3600_000
    ) {
      return { slug: campaign.slug, sent: false, reason: 'rate_limited' };
    }
  }

  // A campaign that features lots has nothing to say when none are live.
  const lots = await selectCampaignLots(admin, campaign.lot_strategy, campaign.lot_count);
  if (campaign.lot_strategy !== 'none' && lots.length === 0) {
    return logSkip(admin, campaign.slug, trigger, 'no_lots_available');
  }

  const audience = await getCampaignAudience(
    admin,
    campaign.slug,
    campaign.max_recipients_per_run,
  );
  if (audience.length === 0) {
    return logSkip(admin, campaign.slug, trigger, 'no_eligible_recipients');
  }

  // Run row first — its id keys the outbox idempotency, so a partial crash
  // resumes into the SAME run rather than minting a duplicate one.
  const { data: runRow, error: runErr } = await admin
    .from('marketing_campaign_runs')
    .insert({
      campaign_slug: campaign.slug,
      triggered_by: trigger,
      recipient_count: audience.length,
      lot_count: lots.length,
      subject: campaign.subject,
    })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`campaign run insert failed: ${runErr?.message}`);
  const runId = (runRow as { id: string }).id;

  const payload = {
    campaign_slug: campaign.slug,
    subject: campaign.subject,
    headline: campaign.headline,
    subcopy: campaign.subcopy,
    cta_label: campaign.cta_label,
    cta_path: campaign.cta_path,
    lots,
  };

  const CHUNK = 100;
  for (let i = 0; i < audience.length; i += CHUNK) {
    const slice = audience.slice(i, i + CHUNK);

    const { error: outErr } = await admin.from('notifications_outbox').insert(
      slice.map((bidderId) => ({
        target_user_id: bidderId,
        kind: 'marketing_campaign',
        idempotency_key: `camp:${campaign.slug}:${runId}:${bidderId}`,
        payload,
      })),
    );
    // 23505 = unique violation: a retry overlapping itself. Anything else is real.
    if (outErr && outErr.code !== '23505') {
      throw new Error(`campaign outbox insert failed: ${outErr.message}`);
    }

    // The frequency-cap ledger. Written AFTER the outbox insert so a crash
    // between the two under-counts rather than silently suppressing a future
    // send the bidder never actually received.
    const { error: sendErr } = await admin.from('marketing_campaign_sends').insert(
      slice.map((bidderId) => ({
        campaign_slug: campaign.slug,
        bidder_id: bidderId,
        run_id: runId,
      })),
    );
    if (sendErr && sendErr.code !== '23505') {
      throw new Error(`campaign send-log insert failed: ${sendErr.message}`);
    }
  }

  return { slug: campaign.slug, sent: true, recipients: audience.length, lots: lots.length };
}

/**
 * Cron entry point. Walks every ENABLED campaign and lets each one self-gate.
 *
 * Campaigns run sequentially: they share the outbox and the email drain's send
 * budget, and a serial loop keeps a single tick's blast radius predictable. One
 * campaign throwing must not stop the others, so failures are captured per
 * campaign rather than aborting the tick.
 */
export async function runMarketingCampaignsAuto(): Promise<CampaignRunResult[]> {
  const admin = getSupabaseAdmin();
  const campaigns = (await listCampaigns(admin)).filter((c) => c.enabled);
  const results: CampaignRunResult[] = [];

  for (const campaign of campaigns) {
    try {
      results.push(await runCampaign(campaign, 'auto'));
    } catch (err) {
      results.push({ slug: campaign.slug, sent: false, reason: `error: ${(err as Error).message}` });
    }
  }

  return results;
}
