// Social posting runner — selects lots, publishes, records, and sweeps.
//
// Sits between compose.ts (pure) and meta-graph.ts (the only file that talks to
// Meta). Everything here is about NOT doing the wrong thing at scale:
// double-posting, posting a lot that already closed, or leaving a live post
// pointing at a dead auction.
//
// ── ORDERING ─────────────────────────────────────────────────────────────────
// The takedown sweep runs BEFORE new posts. If the run dies halfway, the
// failure mode is "fewer new posts today" rather than "closed lots still being
// advertised" — one is a missed opportunity, the other misleads customers into
// clicking through to something they cannot bid on.
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
// The row is INSERTED as 'queued' BEFORE the Graph call, and 0323's partial
// unique index makes a concurrent or retried run collide on the insert instead
// of posting twice. Posting first and recording after would mean a crash
// between the two leaves a live post nobody knows about — unremovable, because
// takedown needs the remote id we never stored.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  readMetaCredentials,
  postToFacebookPage,
  postToInstagram,
  deleteMetaPost,
  type MetaCredentials,
} from './meta-graph';
import {
  buildTaggedUrl,
  composeLotPost,
  firstPublicImage,
  campaignTag,
  type LotForPost,
  type SocialPlatform,
} from './compose';

export interface RunResult {
  ok: boolean;
  reason?: string;
  postsAttempted: number;
  postsSucceeded: number;
  takenDown: number;
  errors: string[];
}

/** Don't flood the page. A handful of good posts beats twenty ignored ones,
 *  and Meta rate-limits aggressively on burst publishing. */
const MAX_POSTS_PER_RUN = 4;

/** Only advertise lots with real time left — a post that goes up 20 minutes
 *  before close cannot convert a new signup, who must register before bidding. */
const MIN_HOURS_LEFT = 4;
const MAX_HOURS_LEFT = 72;

export async function runSocialPosting(opts?: {
  dryRun?: boolean;
  platforms?: SocialPlatform[];
}): Promise<RunResult> {
  const result: RunResult = {
    ok: true, postsAttempted: 0, postsSucceeded: 0, takenDown: 0, errors: [],
  };

  const creds = readMetaCredentials();
  if (!creds) {
    // Not an error: the feature is simply not configured yet. Cron must stay
    // green so a real failure later is visible against a quiet baseline.
    return { ...result, ok: true, reason: 'meta_not_configured' };
  }

  const db = getSupabaseAdmin();

  // ── 1. Takedown sweep, first (see header) ──────────────────────────────────
  result.takenDown = await sweepClosedPosts(db, creds, opts?.dryRun ?? false, result.errors);

  // ── 2. Enabled? ────────────────────────────────────────────────────────────
  // FAILS CLOSED. Anything other than an explicit `true` — column missing, row
  // missing, query errored — means do not publish. Publishing is one-way (a
  // deleted post was still seen), so the ambiguous case must be silence, not a
  // post to the real Page. 0324 adds the column with DEFAULT false so this
  // starts only when a person switches it on, not when credentials appear.
  const { data: settings, error: setErr } = await db
    .from('platform_settings')
    .select('social_posting_enabled')
    .maybeSingle();
  if (setErr) {
    return { ...result, reason: `settings_unreadable: ${setErr.message}` };
  }
  if (settings?.social_posting_enabled !== true) {
    return { ...result, reason: 'disabled_by_setting' };
  }

  // ── 3. Pick lots ───────────────────────────────────────────────────────────
  const now = Date.now();
  const { data: lots, error: lotErr } = await db
    .from('lots')
    .select('id, operator_id, lot_code, display_code, title, msrp_cents, starting_bid_cents, photo_urls, close_at, auction_id, status')
    .eq('status', 'scheduled')
    .not('auction_id', 'is', null)
    .not('close_at', 'is', null)
    .gte('close_at', new Date(now + MIN_HOURS_LEFT * 3_600_000).toISOString())
    .lte('close_at', new Date(now + MAX_HOURS_LEFT * 3_600_000).toISOString())
    .is('deleted_at', null)
    // Highest retail first: the biggest price gap is the strongest hook for
    // someone who has never heard of BinGo, which is the audience that has to
    // grow for 30/day to be reachable.
    .order('msrp_cents', { ascending: false, nullsFirst: false })
    .limit(MAX_POSTS_PER_RUN * 6); // over-fetch; most are filtered below

  if (lotErr) {
    return { ...result, ok: false, reason: `lot_query_failed: ${lotErr.message}` };
  }

  const platforms: SocialPlatform[] = opts?.platforms ?? ['facebook_page'];
  const campaign = campaignTag('lot');

  for (const platform of platforms) {
    let posted = 0;
    for (const row of lots ?? []) {
      if (posted >= MAX_POSTS_PER_RUN) break;

      const lot = row as unknown as LotForPost & { operator_id: string; auction_id: string };
      const image = firstPublicImage(lot);
      // Instagram REQUIRES an image; skip rather than fail the run.
      if (platform === 'instagram' && !image) continue;

      const url = buildTaggedUrl(lot, platform, campaign);
      const message = composeLotPost(lot, platform, url);

      // Reserve the slot BEFORE posting. A unique-violation here means another
      // run already has this lot — skip silently, that is the index doing its
      // job, not an error worth reporting.
      const { data: reserved, error: insErr } = await db
        .from('social_posts')
        .insert({
          operator_id: lot.operator_id,
          lot_id: lot.id,
          auction_id: lot.auction_id,
          platform,
          post_kind: 'lot',
          status: 'queued',
          message,
          image_urls: image ? [image] : [],
          target_url: url,
        })
        .select('id')
        .single();

      if (insErr) {
        if (insErr.code === '23505') continue; // already claimed
        result.errors.push(`insert: ${insErr.message}`);
        continue;
      }

      result.postsAttempted++;
      posted++;

      if (opts?.dryRun) {
        await db.from('social_posts')
          .update({ status: 'skipped', skip_reason: 'dry_run', updated_at: new Date().toISOString() })
          .eq('id', reserved.id);
        continue;
      }

      const sent = platform === 'instagram'
        ? await postToInstagram(creds, message, image as string)
        : await postToFacebookPage(creds, message, url);

      if (sent.ok && sent.remotePostId) {
        result.postsSucceeded++;
        await db.from('social_posts').update({
          status: 'posted',
          remote_post_id: sent.remotePostId,
          permalink: sent.permalink ?? null,
          posted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', reserved.id);
      } else {
        result.errors.push(`${platform} ${lot.lot_code ?? lot.id}: ${sent.error ?? 'unknown'}`);
        // 'failed' releases the slot (the unique index only covers queued and
        // posted), so a later run may legitimately retry this lot.
        await db.from('social_posts').update({
          status: 'failed',
          error: sent.error ?? 'unknown',
          updated_at: new Date().toISOString(),
        }).eq('id', reserved.id);
      }
    }
  }

  return result;
}

/**
 * Delete posts whose auction has ended.
 *
 * Keyed on the AUCTION's end, not the lot's close_at: a lot can close while its
 * auction runs on, and the post still leads somewhere useful until the whole
 * auction is done.
 */
async function sweepClosedPosts(
  db: ReturnType<typeof getSupabaseAdmin>,
  creds: MetaCredentials,
  dryRun: boolean,
  errors: string[],
): Promise<number> {
  const { data: stale, error } = await db
    .from('social_posts')
    .select('id, remote_post_id, auctions!inner(ends_at)')
    .eq('status', 'posted')
    .lt('auctions.ends_at', new Date().toISOString())
    .limit(50);

  if (error) {
    errors.push(`sweep query: ${error.message}`);
    return 0;
  }

  let count = 0;
  for (const row of stale ?? []) {
    const post = row as unknown as { id: string; remote_post_id: string | null };
    if (!post.remote_post_id) continue;
    if (dryRun) { count++; continue; }

    const del = await deleteMetaPost(creds, post.remote_post_id);
    if (del.ok) {
      count++;
      await db.from('social_posts').update({
        status: 'taken_down',
        taken_down_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', post.id);
    } else {
      // Leave it 'posted' so the next sweep retries. A post we failed to remove
      // is exactly the thing that must not be silently forgotten.
      errors.push(`takedown ${post.remote_post_id}: ${del.error ?? 'unknown'}`);
    }
  }
  return count;
}
