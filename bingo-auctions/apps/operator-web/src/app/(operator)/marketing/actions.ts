'use server';

// Server actions for the /marketing console page (mig 0230).
// Staff-gated: every action re-verifies operator_users membership — these
// mutate platform-wide email behavior.

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  enqueueDigest,
  enqueueReferralAnnouncement,
  MANUAL_WINDOW_HOURS,
} from '@/lib/marketing-digest';
import { runCampaign, type Campaign } from '@/lib/marketing-campaigns';

async function requireStaff(): Promise<string | null> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  return staff ? user.id : null;
}

export async function sendDigestNow(): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };

  try {
    const result = await enqueueDigest({ sentBy: 'manual', windowHours: MANUAL_WINDOW_HOURS });
    revalidatePath('/marketing');
    if (!result.sent) {
      return {
        ok: false,
        message:
          result.reason === 'no_lots_closing'
            ? `Nothing closes in the next ${MANUAL_WINDOW_HOURS}h — no digest sent.`
            : 'No opted-in recipients — no digest sent.',
      };
    }
    return {
      ok: true,
      message: `Digest queued: ${result.lots} lots to ${result.recipients} bidders. The email pipeline delivers over the next few minutes.`,
    };
  } catch (err) {
    return { ok: false, message: `Send failed: ${(err as Error).message}` };
  }
}

export async function setDigestLotCount(count: number): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };
  const n = Math.round(count);
  if (!Number.isFinite(n) || n < 1 || n > 24) {
    return { ok: false, message: 'Lot count must be between 1 and 24.' };
  }
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('platform_settings')
    .update({ digest_lot_count: n, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return { ok: false, message: `Save failed: ${error.message}` };
  revalidatePath('/marketing');
  return { ok: true, message: `Digest will feature up to ${n} lots.` };
}

export async function announceReferralProgram(): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };
  try {
    const result = await enqueueReferralAnnouncement();
    revalidatePath('/marketing');
    if (!result.sent) {
      return { ok: false, message: 'Everyone opted-in has already received the announcement.' };
    }
    return {
      ok: true,
      message: `Announcement queued to ${result.recipients} bidders (each gets their own code). Re-pressing later only reaches new signups.`,
    };
  } catch (err) {
    return { ok: false, message: `Send failed: ${(err as Error).message}` };
  }
}

// Square bridges (mig 0236). Directory sync and loyalty accrual run in the
// hourly square-sync cron once toggled on.
export async function setSquareSetting(
  key: 'square_sync_enabled' | 'square_loyalty_enabled',
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('platform_settings')
    .update({ [key]: enabled, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return { ok: false, message: `Toggle failed: ${error.message}` };
  revalidatePath('/marketing');
  const label = key === 'square_sync_enabled' ? 'Square directory sync' : 'Square loyalty accrual';
  return {
    ok: true,
    message: enabled
      ? `${label} ON — the hourly sync starts working through the backlog.`
      : `${label} OFF.`,
  };
}

// ---------------------------------------------------------------------------
// Segmented campaigns (mig 0292)
// ---------------------------------------------------------------------------

/**
 * Enable/disable a campaign. Admin/manager only — flipping this on starts
 * emailing real bidders on the daily cron, which is a bigger deal than the
 * read-only actions above, so it does not use the plain requireStaff() gate.
 */
async function requireManager(): Promise<boolean> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: staff } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = (staff as { role?: string } | null)?.role;
  return role === 'admin' || role === 'manager';
}

export async function setCampaignEnabled(
  slug: string,
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  if (!(await requireManager())) return { ok: false, message: 'Admin or manager only.' };

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('marketing_campaigns')
    .update({ enabled })
    .eq('slug', slug)
    .select('name')
    .maybeSingle();
  if (error) return { ok: false, message: `Toggle failed: ${error.message}` };
  if (!data) return { ok: false, message: `No campaign "${slug}".` };

  revalidatePath('/marketing');
  const name = (data as { name: string }).name;
  return {
    ok: true,
    message: enabled
      ? `${name} ON — runs on the daily cron, respecting its own cadence and per-bidder cap.`
      : `${name} OFF.`,
  };
}

/**
 * Send one campaign now. Bypasses only the campaign-level cadence — the
 * per-bidder cooldown and max-sends cap are enforced in SQL
 * (campaign_audience), so a manual send can never over-mail anyone.
 */
export async function sendCampaignNow(slug: string): Promise<{ ok: boolean; message: string }> {
  if (!(await requireManager())) return { ok: false, message: 'Admin or manager only.' };

  const admin = getSupabaseAdmin();
  const { data: row, error } = await admin
    .from('marketing_campaigns')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) return { ok: false, message: `Lookup failed: ${error.message}` };
  if (!row) return { ok: false, message: `No campaign "${slug}".` };

  try {
    const result = await runCampaign(row as Campaign, 'manual');
    revalidatePath('/marketing');
    if (!result.sent) {
      const why =
        result.reason === 'no_lots_available'
          ? 'No live lots match this campaign right now.'
          : result.reason === 'no_eligible_recipients'
            ? 'Nobody is eligible — everyone in this segment is inside their frequency cap.'
            : (result.reason ?? 'Nothing sent.');
      return { ok: false, message: why };
    }
    return {
      ok: true,
      message: `Queued to ${result.recipients} bidders${result.lots ? ` with ${result.lots} lots` : ''}. The email pipeline delivers over the next few minutes.`,
    };
  } catch (err) {
    return { ok: false, message: `Send failed: ${(err as Error).message}` };
  }
}

export async function setDigestAuto(enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('platform_settings')
    .update({ digest_auto_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return { ok: false, message: `Toggle failed: ${error.message}` };
  revalidatePath('/marketing');
  return {
    ok: true,
    message: enabled
      ? 'Auto digest ON — sends the morning an auction closes, at most every 72h.'
      : 'Auto digest OFF — manual sends only.',
  };
}

// ── Social posting (0323/0324) ───────────────────────────────────────────────
// Guard matches the sibling digest actions above: those already send email to
// every opted-in bidder, so this sits at the same externally-visible risk tier
// rather than inventing a stricter one for the same page. (social_posts' own
// RLS restricts writes to admin/manager; these run as admin and bypass it, so
// requireStaff IS the gate here.)

export async function setSocialPostingEnabled(
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('platform_settings')
    .update({ social_posting_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return { ok: false, message: `Toggle failed: ${error.message}` };
  revalidatePath('/marketing');
  return {
    ok: true,
    message: enabled
      ? 'Social posting ON — the cron run will publish to the Page from now on.'
      : 'Social posting OFF — nothing will publish. Takedowns still run.',
  };
}

/**
 * Dry run: selects lots, composes copy, writes social_posts rows marked
 * 'skipped/dry_run', and publishes NOTHING.
 *
 * This is the intended way to check a change before it reaches the real Page —
 * the copy and the lot selection become inspectable rows instead of something
 * you discover after it is public.
 */
export async function socialDryRun(): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };

  const { runSocialPosting } = await import('@/lib/social/runner');
  const r = await runSocialPosting({ dryRun: true });
  revalidatePath('/marketing');

  if (r.reason === 'meta_not_configured') {
    return { ok: false, message: 'Meta credentials are not set (META_PAGE_ACCESS_TOKEN / META_PAGE_ID).' };
  }
  if (r.reason === 'disabled_by_setting') {
    // Deliberate: the dry run still reports the gate rather than quietly
    // bypassing it, so what you preview matches what a real run would do.
    return { ok: false, message: 'Social posting is OFF — turn it on to preview a real run.' };
  }
  return {
    ok: true,
    message: `Dry run: ${r.postsAttempted} post(s) composed, 0 published, ${r.takenDown} takedown(s) identified.`
      + (r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''),
  };
}

/** Publish now, outside the cron schedule. Respects the same OFF switch. */
export async function socialPostNow(): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff();
  if (!staff) return { ok: false, message: 'Not authorized.' };

  const { runSocialPosting } = await import('@/lib/social/runner');
  const r = await runSocialPosting({ dryRun: false });
  revalidatePath('/marketing');

  if (r.reason === 'meta_not_configured') {
    return { ok: false, message: 'Meta credentials are not set.' };
  }
  if (r.reason === 'disabled_by_setting') {
    return { ok: false, message: 'Social posting is OFF.' };
  }
  return {
    ok: r.ok && r.errors.length === 0,
    message: `${r.postsSucceeded}/${r.postsAttempted} published, ${r.takenDown} taken down.`
      + (r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''),
  };
}
