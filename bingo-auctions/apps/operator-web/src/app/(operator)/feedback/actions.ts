'use server';

// Triage actions for app_feedback (migration 0317).
//
// Writes go through the caller's session client, not the service role: the
// RLS UPDATE policy already restricts triage to admin/manager, so using the
// user client means the database enforces the rule rather than this file
// remembering to. A picker who reaches this action gets a policy violation,
// which is the correct answer.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { buildReplyEmail } from '@/lib/feedback-notify';

const SUPPORT_ADDRESS = 'support@bingoauctions.com';
const SUPPORT_FROM = `BinGo Auctions Support <${SUPPORT_ADDRESS}>`;

// Mirrors the CHECK constraint in 0317. Kept in sync by hand — the generated
// types don't cover this table yet.
const STATUSES = ['new', 'triaged', 'planned', 'fixed', 'wont_fix'] as const;

const triageSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(STATUSES),
  note: z.string().trim().max(2000).nullable(),
});

export type TriageStatus = (typeof STATUSES)[number];

export async function triageFeedback(input: z.infer<typeof triageSchema>) {
  const parsed = triageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'not authenticated' };

  // 'fixed' and 'wont_fix' are terminal — stamp the closing time so the list
  // can show how long a report sat. Reopening (back to new/triaged/planned)
  // clears it rather than leaving a stale timestamp behind.
  const terminal = parsed.data.status === 'fixed' || parsed.data.status === 'wont_fix';

  const { error } = await supabase
    .from('app_feedback')
    .update({
      status: parsed.data.status,
      triage_note: parsed.data.note,
      resolved_at: terminal ? new Date().toISOString() : null,
      // app_feedback postdates the last database.types.ts regen, so the
      // generated Update type doesn't know these columns yet.
    } as never)
    .eq('id', parsed.data.id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath('/feedback');
  return { ok: true as const };
}

const replySchema = z.object({ id: z.string().uuid() });

/**
 * 0477: email the saved reply (triage_note) to the customer who sent this
 * item, from the support address, and log it. Staff items are answered in the
 * staff app's "Your reports" list, not by email. Admin/manager only.
 */
export async function emailFeedbackReply(input: z.infer<typeof replySchema>) {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid' };

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'not authenticated' };
  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  const role = (me as { role?: string } | null)?.role;
  if (role !== 'admin' && role !== 'manager') return { ok: false as const, error: 'Admins and managers only.' };

  const { data: row, error: readErr } = await supabase
    .from('app_feedback')
    .select('id, app, status, message, triage_note, contact_email, author_id, reply_emailed_at')
    .eq('id', parsed.data.id)
    .single();
  if (readErr || !row) return { ok: false as const, error: 'Feedback not found (or replies not set up yet).' };
  const r = row as {
    app: string; status: string; message: string; triage_note: string | null;
    contact_email: string | null; author_id: string | null;
  };
  const reply = (r.triage_note ?? '').trim();
  if (!reply) return { ok: false as const, error: 'Save a reply first.' };

  const admin = getSupabaseAdmin();
  const to =
    r.contact_email ??
    (r.app !== 'staff' && r.author_id ? (await admin.auth.admin.getUserById(r.author_id)).data.user?.email ?? null : null);
  if (!to) return { ok: false as const, error: 'No email address for this sender.' };

  const env = process.env;
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false as const, error: 'Email is not configured.' };
  const email = buildReplyEmail(reply, r.message);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.FEEDBACK_REPLY_FROM ?? SUPPORT_FROM,
      reply_to: SUPPORT_ADDRESS,
      to: [to],
      subject: email.subject,
      text: email.text,
    }),
  });
  if (!res.ok) return { ok: false as const, error: `Email was not sent (${res.status}).` };

  const sentAt = new Date().toISOString();
  await supabase
    .from('app_feedback')
    .update({ reply_emailed_at: sentAt } as never)
    .eq('id', parsed.data.id);
  await admin.from('operator_audit_log').insert({
    operator_id: (me as { operator_id: string }).operator_id,
    actor_user_id: user.id,
    action_type: 'feedback.reply_emailed',
    target_id: parsed.data.id,
    after_state: { app: r.app, status: r.status, reply_chars: reply.length, sent_at: sentAt },
  } as never);

  revalidatePath('/feedback');
  return { ok: true as const, sentAt };
}
