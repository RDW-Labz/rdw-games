// POST /api/debug/alert-check — pager self-test (gated)
//
// Answers one question that nothing else could: **who does an ops alert
// actually reach right now?**
//
// OPS_ALERT_EMAIL is a Cloudflare Worker secret. Worker secrets are write-only
// — not readable from the dashboard, from wrangler, or from CI — so after
// setting it the only evidence of what it contains was the arrival of a real
// alert. A typo did not produce an error; it produced silence, and silence is
// indistinguishable from "nothing has gone wrong yet". That is exactly how the
// 2026-09-19 outage reached nobody for 45 minutes.
//
// So this endpoint resolves the list the same way sendOpsAlert does and
// RETURNS IT. One curl tells you whether the notify list is what you think it
// is, before you need it to be.
//
//   curl -XPOST -H "x-cron-secret: $CRON_SECRET" \
//     https://bingoauctions.com/api/debug/alert-check
//
//   { "ok": true,
//     "recipients": ["jmacluer@gmail.com", "michael@cluerholdings.com", ...],
//     "recipient_count": 4,
//     "using_fallback": false,
//     "sent": true }
//
// `?dry=1` resolves the recipients WITHOUT sending, for when you only want to
// read the list back.
//
// ── Why this is safe ────────────────────────────────────────────────────────
//   * Gated behind CRON_SECRET, the same bar as every /api/cron/* route.
//   * Its own throttle key (`ops_alert_test`), so it can never consume or
//     suppress the throttle slot of a real alert.
//   * skipThrottle, so a person fixing a typo can retry immediately instead of
//     waiting an hour — the whole point is a fast feedback loop.
//   * The subject says TEST so nobody on the list treats it as an incident.
//
// Returning the addresses is deliberate. They are internal staff addresses,
// already known to anyone holding CRON_SECRET, and withholding them would
// defeat the endpoint: a masked list still passes with `micheal@` spelled
// wrong. See RUNBOOK and PR #345.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { parseAlertPhones, parseAlertRecipients, sendOpsAlert } from '@/lib/ops-alert';

export const runtime = 'nodejs';

const FALLBACK_RECIPIENT = 'jmacluer@gmail.com';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const dryRun = new URL(req.url).searchParams.get('dry') === '1';
  const stamp = new Date().toISOString();

  const raw = process.env.OPS_ALERT_EMAIL;
  const recipients = parseAlertRecipients(raw);
  // Distinguish "the secret is set and resolved to this" from "the secret is
  // missing and you are looking at the hardcoded default". Both produce a
  // plausible list; only one means the deploy actually carried the value.
  const usingFallback =
    recipients.length === 1 && recipients[0] === FALLBACK_RECIPIENT && !raw?.includes('@');

  // A missing RESEND_API_KEY is the other way this goes quiet. sendOpsAlert
  // logs and returns false in that case; say so here rather than reporting a
  // bare `sent: false` that could mean either.
  const resendConfigured = Boolean(process.env.RESEND_API_KEY);

  // The SMS half of the pager (pg_cron failure spikes only). Same write-only
  // problem as OPS_ALERT_EMAIL — worse, in fact, because a wrong digit pages a
  // stranger rather than nobody. `twilio_configured` distinguishes "no numbers
  // are listed" from "numbers are listed and the credentials to reach them are
  // not on the Worker", which look identical from the outside: silence.
  const phones = parseAlertPhones(process.env.OPS_ALERT_SMS);
  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM_PHONE || process.env.TWILIO_MESSAGING_SERVICE_SID),
  );

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      recipients,
      recipient_count: recipients.length,
      using_fallback: usingFallback,
      resend_configured: resendConfigured,
      sms_recipients: phones,
      sms_recipient_count: phones.length,
      twilio_configured: twilioConfigured,
      sent: false,
      checked_at: stamp,
    });
  }

  const sent = await sendOpsAlert(
    getSupabaseAdmin(),
    'ops_alert_test',
    `TEST — pager check, no action needed (${stamp})`,
    `This is a deliberate test of the ops alert pager. Nothing is wrong.\n\n` +
      `It was triggered by hand against /api/debug/alert-check to confirm that ` +
      `OPS_ALERT_EMAIL on the Worker resolves to the people who should be told ` +
      `when something IS wrong.\n\n` +
      `Resolved recipients (${recipients.length}):\n` +
      recipients.map((r) => `  - ${r}`).join('\n') +
      `\n\nIf you received this and you did not expect to be on the ops notify ` +
      `list, say so — being on it by accident is as much a problem as being off ` +
      `it by accident.\n\n` +
      `If someone who SHOULD be on this list did not receive it, OPS_ALERT_EMAIL ` +
      `is wrong. It is a comma-separated list, set as a GitHub repo secret and ` +
      `pushed to the Worker by deploy-cloudflare.yml — it takes effect on the ` +
      `next deploy, not when the secret is saved.`,
    // sms:true so the test exercises BOTH channels. A pager check that only
    // proves the email works would have passed on 2026-09-20 and still left
    // the four-minute burst unpaged.
    { skipThrottle: true, sms: true },
  );

  // `sent` is false for a real reason — a missing key, or Resend refusing the
  // request. Report it as a failure rather than a 200 with a quiet flag, so a
  // broken pager cannot be mistaken for a working one by something reading the
  // status code. That mistake is the reason this endpoint exists.
  return NextResponse.json(
    {
      ok: sent,
      recipients,
      recipient_count: recipients.length,
      using_fallback: usingFallback,
      resend_configured: resendConfigured,
      sms_recipients: phones,
      sms_recipient_count: phones.length,
      twilio_configured: twilioConfigured,
      sent,
      reason: sent
        ? undefined
        : resendConfigured
          ? 'resend_rejected_the_send — check the Worker logs for [ops-alert]'
          : 'RESEND_API_KEY missing on the Worker',
      checked_at: stamp,
    },
    { status: sent ? 200 : 503 },
  );
}
