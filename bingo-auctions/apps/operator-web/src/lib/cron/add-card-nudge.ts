// add-card-nudge.ts
//
// Funnel repair (marketing batch, 2026-07-05): bidders who registered but
// never put a card on file can't bid — place_bid rejects without one. This
// sweep sends each of them ONE "you're one step from bidding" email + push,
// ~24 hours after signup (long enough to not pester someone mid-onboarding,
// soon enough that the lots they browsed are still open).
//
// Send-once guarantees, in order:
//   1. bidders.card_nudged_at (mig 0228) is stamped BEFORE the outbox insert
//      (claim-first, same pattern as the drains) — a crash between the two
//      loses at most one nudge, never duplicates one.
//   2. notifications_outbox idempotency_key 'card_nudge:{bidder_id}' is
//      UNIQUE — even a double-claim race collapses to one row.
//
// Window: created_at between 24h and 30d ago. The 30-day floor keeps the
// first-ever run from emailing long-dormant accounts out of nowhere.
//
// Triggered from /api/cron/add-card-nudge hourly.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';

const NUDGE_AFTER_HOURS = 24;
const MAX_ACCOUNT_AGE_DAYS = 30;
const BATCH_SIZE = 50;

export type AddCardNudgeResult = {
  scanned: number;
  nudged: number;
  failed: number;
  /** Auth users with no bidders row who got the finish-onboarding email. */
  onboarding_nudged: number;
};

export async function runAddCardNudge(): Promise<AddCardNudgeResult> {
  const admin = getSupabaseAdmin();
  const now = Date.now();
  const newestEligible = new Date(now - NUDGE_AFTER_HOURS * 3600_000).toISOString();
  const oldestEligible = new Date(now - MAX_ACCOUNT_AGE_DAYS * 86400_000).toISOString();

  const { data: candidates, error } = await admin
    .from('bidders')
    .select('id, created_at')
    .is('default_payment_method_id', null)
    .is('card_nudged_at', null)
    .is('deleted_at', null)
    .lt('created_at', newestEligible)
    .gt('created_at', oldestEligible)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[add-card-nudge] candidate fetch failed:', error.message);
    return { scanned: 0, nudged: 0, failed: 0, onboarding_nudged: 0 };
  }

  const bidders = candidates ?? [];
  if (bidders.length === 0) {
    const onboardingOnly = await runOnboardingOrphanNudge(admin, newestEligible, oldestEligible);
    return { scanned: 0, nudged: 0, failed: 0, onboarding_nudged: onboardingOnly };
  }

  let nudged = 0;
  let failed = 0;

  for (const bidder of bidders) {
    // Claim first — only proceed to enqueue if WE stamped the row.
    const { data: claimed, error: claimErr } = await admin
      .from('bidders')
      .update({ card_nudged_at: new Date().toISOString() })
      .eq('id', bidder.id)
      .is('card_nudged_at', null)
      .select('id');

    if (claimErr || !claimed || claimed.length === 0) {
      if (claimErr) {
        console.warn('[add-card-nudge] claim failed for', bidder.id, claimErr.message);
        failed++;
      }
      continue; // already claimed by a concurrent tick — not a failure
    }

    const { error: insErr } = await admin.from('notifications_outbox').insert({
      target_user_id: bidder.id,
      kind: 'add_card_nudge',
      idempotency_key: `card_nudge:${bidder.id}`,
      payload: {
        // title/body ride in the payload so even an older notifications-drain
        // build (generic-kind fallback) renders something sensible.
        title: 'Add a card to start bidding',
        body: "Your account is ready — add a card and you can bid. You're only charged if you win.",
        deep_link: bidderDeepLink('profile/payment-method'),
      },
    });

    if (insErr) {
      console.error('[add-card-nudge] enqueue failed for', bidder.id, insErr.message);
      failed++;
      continue;
    }
    nudged++;
  }

  const onboardingNudged = await runOnboardingOrphanNudge(admin, newestEligible, oldestEligible);

  return { scanned: bidders.length, nudged, failed, onboarding_nudged: onboardingNudged };
}

// ── Onboarding-orphan nudge (mig 0239) ───────────────────────────────────────
//
// Auth users who created a login but never finished /bidder/onboarding have
// no bidders row at all, so the card nudge above can't reach them (35 such
// users in the 3 days before 2026-07-06). Same 24h→30d window, ONE email
// ever. There's no bidders column to stamp, so the outbox UNIQUE
// idempotency_key 'onboard_nudge:{user_id}' is the entire send-once
// guarantee (upsert with ignoreDuplicates). The recipient email rides in
// payload.email because the email drain's bidders/operator_users lookups
// can't resolve an orphan.
async function runOnboardingOrphanNudge(
  admin: ReturnType<typeof getSupabaseAdmin>,
  newestEligible: string,
  oldestEligible: string,
): Promise<number> {
  const MAX_PER_RUN = 25; // one email-drain batch — don't crowd out receipts
  const PER_PAGE = 1000;
  const MAX_PAGES = 20;

  // Collect candidate auth users in the window. listUsers is the only way
  // at auth.users from supabase-js; page until a short page (same pattern
  // as e2e global-setup after the 200-user pagination incident).
  const candidates: Array<{ id: string; email: string; created_at: string }> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      console.error('[onboarding-nudge] listUsers failed:', error.message);
      return 0;
    }
    for (const u of data.users) {
      if (!u.email || !u.created_at) continue;
      if (u.created_at >= newestEligible || u.created_at <= oldestEligible) continue;
      candidates.push({ id: u.id, email: u.email, created_at: u.created_at });
    }
    if (data.users.length < PER_PAGE) break;
  }
  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.id);
  const [{ data: bidderRows }, { data: staffRows }, { data: nudgedRows }] = await Promise.all([
    admin.from('bidders').select('id').in('id', ids),
    admin.from('operator_users').select('user_id').in('user_id', ids),
    admin
      .from('notifications_outbox')
      .select('target_user_id')
      .eq('kind', 'onboarding_nudge')
      .in('target_user_id', ids),
  ]);
  const exclude = new Set<string>([
    ...((bidderRows ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((staffRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
    ...((nudgedRows ?? []) as Array<{ target_user_id: string }>).map((r) => r.target_user_id),
  ]);

  const orphans = candidates.filter((c) => !exclude.has(c.id)).slice(0, MAX_PER_RUN);
  if (orphans.length === 0) return 0;

  const { data: inserted, error: insErr } = await admin
    .from('notifications_outbox')
    .upsert(
      orphans.map((o) => ({
        target_user_id: o.id,
        kind: 'onboarding_nudge',
        idempotency_key: `onboard_nudge:${o.id}`,
        payload: { email: o.email },
      })),
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id');
  if (insErr) {
    console.error('[onboarding-nudge] enqueue failed:', insErr.message);
    return 0;
  }
  return (inserted ?? []).length;
}
