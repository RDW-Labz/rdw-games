// New-feedback emails (every 5 min) and the 07:00 CT digest (every 30 min,
// sends once per Chicago day). Recipients: FEEDBACK_NOTIFY_EMAIL, else
// OPS_ALERT_EMAIL. Both no-op until migration 0477 exists (probed with a GET:
// a HEAD on a missing column/table reads as success in supabase-js, see #624).
// A failed send leaves the item pending, so the next tick retries it.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  NOTIFY_BURST_WINDOW_MS,
  buildBatchEmail,
  buildDigestEmail,
  buildFeedbackEmail,
  chicagoDayHour,
  isDigestHour,
  parseRecipients,
  planNotify,
  staleNew,
  type FeedbackItem,
} from '@/lib/feedback-notify';

const SIGNED_TTL_S = 7 * 24 * 60 * 60;
const COLS =
  'id, created_at, app, kind, message, reporter_label, screen, app_version, update_id, platform, os_version, device_model, status, contact_email, author_id, attachments';

export type Sender = (to: string[], subject: string, text: string) => Promise<boolean>;
export type Deps = { supabase?: SupabaseClient; send?: Sender; env?: Record<string, string | undefined>; now?: Date };

type Row = Omit<FeedbackItem, 'has_reply_to' | 'attachment_urls'> & {
  contact_email: string | null;
  author_id: string | null;
  attachments: { path: string }[] | null;
};

export function recipientsFrom(env: Record<string, string | undefined>): string[] {
  const r = parseRecipients(env['FEEDBACK_NOTIFY_EMAIL']);
  return r.length > 0 ? r : parseRecipients(env['OPS_ALERT_EMAIL']);
}

export function baseUrlFrom(env: Record<string, string | undefined>): string {
  return env['NEXT_PUBLIC_SITE_URL'] || 'https://bingoauctions.com';
}

export const resendSender =
  (env: Record<string, string | undefined>): Sender =>
  async (to, subject, text) => {
    const key = env['RESEND_API_KEY'];
    if (!key || to.length === 0) return false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env['RESEND_FROM_EMAIL'] ?? 'BinGo Auctions <no-reply@bingoauctions.com>',
          to,
          subject,
          text,
        }),
      });
      if (!res.ok) console.error('[feedback-notify] resend refused', res.status, (await res.text()).slice(0, 200));
      return res.ok;
    } catch (e) {
      console.error('[feedback-notify] resend failed', (e as Error).message);
      return false;
    }
  };

async function ready(sb: SupabaseClient): Promise<boolean> {
  const { data, error } = await sb.from('app_feedback').select('id, notified_at').limit(1);
  return !error && Array.isArray(data);
}

async function toItems(sb: SupabaseClient, rows: Row[]): Promise<FeedbackItem[]> {
  const paths = rows.flatMap((r) => (r.attachments ?? []).map((a) => a.path));
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data } = await sb.storage.from('feedback-attachments').createSignedUrls(paths, SIGNED_TTL_S);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  return rows.map((r) => ({
    ...r,
    has_reply_to: Boolean(r.contact_email) || (r.app !== 'staff' && Boolean(r.author_id)),
    attachment_urls: (r.attachments ?? []).map((a) => signed.get(a.path)).filter((u): u is string => Boolean(u)),
  }));
}

export async function runFeedbackNotify(deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const sb = deps.supabase ?? getSupabaseAdmin();
  const send = deps.send ?? resendSender(env);
  const now = deps.now ?? new Date();
  if (!(await ready(sb))) return { skipped: 'migration_0477_not_applied' as const };
  const to = recipientsFrom(env);
  if (to.length === 0) return { skipped: 'no_recipients' as const };

  const { data: pendingRows, error } = await sb
    .from('app_feedback')
    .select(COLS)
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) return { error: error.message };
  if (!pendingRows?.length) return { pending: 0, single: 0, batched: 0 };

  const since = new Date(now.getTime() - NOTIFY_BURST_WINDOW_MS).toISOString();
  const { count } = await sb.from('app_feedback').select('id', { count: 'exact' }).gte('notified_at', since).limit(1);
  const items = await toItems(sb, pendingRows as unknown as Row[]);
  const plan = planNotify(items, count ?? 0);
  const base = baseUrlFrom(env);
  const mark = async (ids: string[]) => {
    await sb.from('app_feedback').update({ notified_at: now.toISOString() } as never).in('id', ids).is('notified_at', null);
  };

  let single = 0;
  for (const it of plan.single) {
    const e = buildFeedbackEmail(it, base);
    if (!(await send(to, e.subject, e.text))) return { pending: items.length, single, batched: 0, failed: it.id };
    await mark([it.id]);
    single++;
  }
  let batched = 0;
  if (plan.batched.length > 0) {
    const e = buildBatchEmail(plan.batched, base);
    if (await send(to, e.subject, e.text)) {
      await mark(plan.batched.map((i) => i.id));
      batched = plan.batched.length;
    }
  }
  return { pending: items.length, single, batched };
}

export async function runFeedbackDigest(deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const sb = deps.supabase ?? getSupabaseAdmin();
  const send = deps.send ?? resendSender(env);
  const now = deps.now ?? new Date();
  if (!isDigestHour(now)) return { skipped: 'not_digest_hour' as const };
  if (!(await ready(sb))) return { skipped: 'migration_0477_not_applied' as const };
  const to = recipientsFrom(env);
  if (to.length === 0) return { skipped: 'no_recipients' as const };

  const { day } = chicagoDayHour(now);
  const { data: claimed, error: claimErr } = await sb
    .from('feedback_digest_runs')
    .upsert({ day }, { onConflict: 'day', ignoreDuplicates: true })
    .select('day');
  if (claimErr) return { error: claimErr.message };
  if (!claimed?.length) return { skipped: 'already_sent_today' as const };

  const { data: rows, error } = await sb
    .from('app_feedback')
    .select(COLS)
    .eq('status', 'new')
    .lt('created_at', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    await sb.from('feedback_digest_runs').delete().eq('day', day);
    return { error: error.message };
  }
  const items = staleNew(await toItems(sb, (rows ?? []) as unknown as Row[]), now);
  if (items.length === 0) return { sent: false, items: 0 };
  const e = buildDigestEmail(items, now, baseUrlFrom(env));
  if (!(await send(to, e.subject, e.text))) {
    // Release the day so the 07:30 tick retries.
    await sb.from('feedback_digest_runs').delete().eq('day', day);
    return { sent: false, items: items.length, retry: true };
  }
  await sb.from('feedback_digest_runs').update({ items: items.length }).eq('day', day);
  return { sent: true, items: items.length };
}
