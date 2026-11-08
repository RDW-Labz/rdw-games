// Ops alert email via Resend, throttled per check via ops_alert_throttle
// (0215) so an ongoing incident emails at most once per hour, not every
// 5-minute cron tick.
//
// Lifted out of /api/cron/health-check on 2026-09-14 so the invariant
// monitor (0357) can share it. Behaviour unchanged: failures are logged,
// never thrown — alerting must not take the caller down with it. Returns
// true only when the email was actually accepted by Resend, so a caller
// that tracks "has this been sent" can trust the answer.
//
// Recipients: OPS_ALERT_EMAIL on the Worker, else the super-admin inbox. It is
// a COMMA-SEPARATED LIST, matching SUPER_ADMIN_EMAILS, because until 2026-09-20
// this sent to exactly one address — `to: [to]` — and there was no way to add a
// second person without editing code. PR #276 confirms the 08-20 alert reached
// the owner and was acted on the same day, so the pipe works; it was the
// addressing that could not grow.
//
// deploy-cloudflare.yml now pushes OPS_ALERT_EMAIL, so the recipient list is
// stated in the repo rather than being whatever was typed into a Worker once.
// The loop skips empty secrets, so an unset repo secret leaves the Worker's
// hand-set value alone and the fallback below still applies to a bare Worker.

import type { SupabaseClient } from '@supabase/supabase-js';

const THROTTLE_MS = 60 * 60 * 1000;

// Fallback = super-admin inbox. The upstream platform default silently sent
// BinGo ops alerts to the old clovrbid@gmail.com inbox when OPS_ALERT_EMAIL was
// unset (2026-07-04 audit), which is why the fallback is named here explicitly
// rather than inherited.
const FALLBACK_RECIPIENT = 'jmacluer@gmail.com';

/**
 * Split OPS_ALERT_EMAIL into addresses.
 *
 * Deliberately forgiving about separators and whitespace — this value gets
 * typed into a GitHub secret box by a person, and an alert that silently goes
 * nowhere because someone used `; ` is the failure mode this whole area is
 * being repaired for. Anything without an `@` is dropped rather than passed to
 * Resend, which would reject the entire send and take the good addresses down
 * with the bad one.
 *
 * Returns the fallback when nothing usable survives, so there is no
 * configuration that results in an alert reaching nobody.
 */
export function parseAlertRecipients(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,;\s]+/)) {
    const addr = part.trim();
    if (!addr || !addr.includes('@')) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out.length > 0 ? out : [FALLBACK_RECIPIENT];
}

/**
 * Split OPS_ALERT_SMS into phone numbers.
 *
 * Deliberately stricter than parseAlertRecipients and with NO fallback. An
 * email fallback to the super-admin inbox is harmless; a phone fallback would
 * mean guessing a number, and a wrong number pages a stranger at 19:06 on a
 * Saturday. Unset means "no SMS", which is a safe state — the email still
 * goes.
 *
 * Requires E.164 (`+15015550123`): Twilio rejects anything else, and one bad
 * number does not take the good ones down because each message is its own
 * API call.
 */
export function parseAlertPhones(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,;\s]+/)) {
    const num = part.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(num)) continue;
    if (seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }
  return out;
}

/**
 * Send one ops alert by SMS to every number on OPS_ALERT_SMS.
 *
 * Plain fetch against Twilio's REST API rather than the `twilio` SDK that
 * lib/cron/sms-drain.ts uses — same reason sendOpsAlert calls Resend with
 * fetch. This runs on a Worker, and the alert path is the last thing that
 * should depend on a Node SDK loading correctly.
 *
 * Returns the number of messages Twilio accepted. Failures are logged, never
 * thrown: the pager must not be able to take its caller down.
 */
/** Send one ops alert by email to every address on OPS_ALERT_EMAIL. */
async function sendOpsEmail(subject: string, detail: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = parseAlertRecipients(process.env.OPS_ALERT_EMAIL);
  if (!key) {
    console.error('[ops-alert] RESEND_API_KEY missing — cannot send ops alert:', subject);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL ?? 'BinGo Auctions <no-reply@bingoauctions.com>',
        to,
        subject: `[BinGo ops] ${subject}`,
        text:
          `${detail}\n\nFired by /api/cron/health-check at ${new Date().toISOString()}. ` +
          `Throttled to one email per check per hour.`,
      }),
    });
    if (!res.ok) {
      console.error('[ops-alert] resend send failed', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    // Caught here rather than in sendOpsAlert's outer try so that a Resend
    // outage cannot skip the SMS attempt that follows it.
    console.error('[ops-alert] resend threw', (err as Error).message);
    return false;
  }
}

async function sendOpsSms(subject: string): Promise<number> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const to = parseAlertPhones(process.env.OPS_ALERT_SMS);
  if (to.length === 0) return 0;
  if (!sid || !token) {
    console.error('[ops-alert] TWILIO_ACCOUNT_SID/AUTH_TOKEN missing — cannot SMS:', subject);
    return 0;
  }

  const from = process.env.TWILIO_FROM_PHONE;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!from && !service) {
    console.error('[ops-alert] neither TWILIO_FROM_PHONE nor TWILIO_MESSAGING_SERVICE_SID set');
    return 0;
  }

  // One segment. The SMS is a pager, not a report: it says which check fired
  // and that is all. Whoever it wakes reads the email or the runbook next.
  const body = `[BinGo ops] ${subject}`.slice(0, 160);
  const auth = btoa(`${sid}:${token}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;

  let sent = 0;
  for (const number of to) {
    try {
      const form = new URLSearchParams({ To: number, Body: body });
      if (service) form.set('MessagingServiceSid', service);
      else if (from) form.set('From', from);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      if (res.ok) sent++;
      else console.error('[ops-alert] twilio send failed', number, res.status, await res.text());
    } catch (err) {
      // Keep going: one unreachable number must not silence the rest.
      console.error('[ops-alert] twilio threw for', number, (err as Error).message);
    }
  }
  return sent;
}

export async function sendOpsAlert(
  supabase: SupabaseClient,
  checkName: string,
  subject: string,
  detail: string,
  // `skipThrottle` exists for /api/debug/alert-check and nothing else. The
  // hourly throttle is right for real alerts and wrong for a deliberate test:
  // a person verifying the notify list should not have to wait an hour to
  // retry after fixing a typo in it. Never pass this from a health check —
  // that turns a quiet incident into an email every five minutes.
  // `sms` opts a check INTO the SMS pager on top of the email. Off by
  // default: most ops alerts describe a backlog that can wait for an inbox.
  // Turn it on only where minutes matter — see the health check's pg_cron
  // spike, where the 2026-09-20 burst lasted four minutes and the email
  // reached the owner twenty-five minutes after Resend accepted it.
  opts: { skipThrottle?: boolean; sms?: boolean } = {},
): Promise<boolean> {
  try {
    if (!opts.skipThrottle) {
      const { data: throttle } = await supabase
        .from('ops_alert_throttle')
        .select('last_emailed_at')
        .eq('check_name', checkName)
        .maybeSingle();
      const last = throttle
        ? Date.parse((throttle as { last_emailed_at: string }).last_emailed_at)
        : 0;
      if (Number.isFinite(last) && last > 0 && Date.now() - last < THROTTLE_MS) return false;
    }

    // Both channels are attempted independently and the throttle is stamped
    // if EITHER landed. Previously a Resend failure returned early; on a check
    // that pages by SMS that would have let the flakier channel suppress the
    // more reliable one.
    const emailOk = await sendOpsEmail(subject, detail);
    const smsSent = opts.sms ? await sendOpsSms(subject) : 0;

    if (!emailOk && smsSent === 0) return false;

    await supabase
      .from('ops_alert_throttle')
      .upsert({ check_name: checkName, last_emailed_at: new Date().toISOString() });
    return true;
  } catch (err) {
    console.error('[ops-alert] sendOpsAlert failed', (err as Error).message);
    return false;
  }
}
