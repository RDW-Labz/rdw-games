// Drains meta_events_outbox to Meta's Conversions API.
//
// Mirrors email-drain's shape: fixed batch, bounded attempts, per-row error
// recorded rather than thrown, so one poisoned row cannot stall the queue.
//
// The events are enqueued by triggers (mig 0339) because the only place that
// sees every bid from every client is Postgres — `place_bid` is a PostgREST
// RPC and most bidding happens in the native app, so there is no request
// handler to hang a conversion on.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  readCapiCredentials,
  sendCapiEvents,
  MAX_EVENT_AGE_DAYS,
  type CapiEvent,
} from '@/lib/social/meta-capi';

/** Meta accepts 1000 per call; 200 keeps a single failure cheap to retry and
 *  the cron well inside its timeout. */
const BATCH_SIZE = 200;
const MAX_ATTEMPTS = 4;

type OutboxRow = {
  id: string;
  event_name: 'Purchase' | 'Lead' | 'CompleteRegistration';
  event_id: string;
  bidder_id: string | null;
  value_cents: number | null;
  occurred_at: string;
  attempt_count: number;
};

export interface DrainResult {
  skipped?: string;
  claimed: number;
  sent: number;
  expired: number;
  /** Rows retired because the bidder opted out of ad tracking (mig 0340). */
  suppressed: number;
  failed: number;
  error?: string;
}

export async function runMetaCapiDrain(): Promise<DrainResult> {
  const creds = readCapiCredentials();
  if (!creds) {
    // Not an error, and now it can only mean one thing: the dataset id is a
    // literal, so the token is the sole missing piece. Saying so exactly is the
    // point — "not configured" sent whoever read this log hunting the wrong
    // variable. Rows keep queuing and go out when the secret lands, as long as
    // they are still inside Meta's 7-day window.
    return { skipped: 'META_CAPI_TOKEN / META_PAGE_ACCESS_TOKEN not set on the Worker', claimed: 0, sent: 0, expired: 0, suppressed: 0, failed: 0 };
  }

  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from('meta_events_outbox')
    .select('id, event_name, event_id, bidder_id, value_cents, occurred_at, attempt_count')
    .is('sent_at', null)
    .lt('attempt_count', MAX_ATTEMPTS)
    .order('occurred_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return { claimed: 0, sent: 0, expired: 0, suppressed: 0, failed: 0, error: error.message };

  const rows = (data ?? []) as OutboxRow[];
  if (rows.length === 0) return { claimed: 0, sent: 0, expired: 0, suppressed: 0, failed: 0 };

  // Rows Meta would reject on age. Retrying them forever burns the attempt
  // budget and hides live failures behind noise, so they are retired with a
  // reason rather than left to rot in the queue.
  const cutoff = Date.now() - MAX_EVENT_AGE_DAYS * 86_400_000;
  const expired = rows.filter((r) => new Date(r.occurred_at).getTime() < cutoff);
  const fresh = rows.filter((r) => new Date(r.occurred_at).getTime() >= cutoff);

  if (expired.length > 0) {
    await db
      .from('meta_events_outbox')
      .update({ sent_at: new Date().toISOString(), last_error: 'expired: older than Meta 7-day window' })
      .in('id', expired.map((r) => r.id));
  }

  if (fresh.length === 0) {
    return { claimed: rows.length, sent: 0, expired: expired.length, suppressed: 0, failed: 0 };
  }

  // Contact details are resolved HERE and hashed inside meta-capi, so they are
  // never stored in the outbox and never logged.
  //
  // The same read carries ad_tracking_opt_out (mig 0340). A bidder who opts out
  // has already had their QUEUED rows retired by that migration's trigger, but
  // this check is what makes the guarantee hold for a row enqueued in the gap
  // between the trigger firing and this batch being claimed. Two places is the
  // right number here: the privacy policy promises the opt-out works, and
  // "works except for a few seconds" is not what it says.
  const bidderIds = [...new Set(fresh.map((r) => r.bidder_id).filter((v): v is string => !!v))];
  const contacts = new Map<
    string,
    { email: string | null; phone: string | null; fbp: string | null; fbc: string | null }
  >();
  const optedOut = new Set<string>();
  if (bidderIds.length > 0) {
    const { data: bidders } = await db
      .from('bidders')
      .select('id, email, phone, ad_tracking_opt_out, meta_fbp, meta_fbc')
      .in('id', bidderIds);
    for (const b of (bidders ?? []) as Array<{
      id: string;
      email: string | null;
      phone: string | null;
      ad_tracking_opt_out: boolean | null;
      meta_fbp: string | null;
      meta_fbc: string | null;
    }>) {
      if (b.ad_tracking_opt_out) optedOut.add(b.id);
      else
        contacts.set(b.id, {
          email: b.email,
          phone: b.phone,
          fbp: b.meta_fbp,
          fbc: b.meta_fbc,
        });
    }
  }

  const suppressed = fresh.filter((r) => r.bidder_id && optedOut.has(r.bidder_id));
  const sendable = fresh.filter((r) => !(r.bidder_id && optedOut.has(r.bidder_id)));

  if (suppressed.length > 0) {
    await db
      .from('meta_events_outbox')
      .update({ sent_at: new Date().toISOString(), last_error: 'suppressed: bidder opted out of ad tracking' })
      .in('id', suppressed.map((r) => r.id));
  }

  if (sendable.length === 0) {
    return { claimed: rows.length, sent: 0, expired: expired.length, suppressed: suppressed.length, failed: 0 };
  }

  const events: CapiEvent[] = sendable.map((r) => {
    const c = r.bidder_id ? contacts.get(r.bidder_id) : undefined;
    return {
      eventName: r.event_name,
      eventId: r.event_id,
      occurredAt: new Date(r.occurred_at),
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      externalId: r.bidder_id,
      valueCents: r.value_cents,
      fbp: c?.fbp ?? null,
      fbc: c?.fbc ?? null,
    };
  });

  const result = await sendCapiEvents(events, creds);
  const now = new Date().toISOString();

  if (!result.ok) {
    // Whole batch failed: bump attempts so MAX_ATTEMPTS eventually retires
    // them, and keep the reason on the row.
    await db
      .from('meta_events_outbox')
      .update({ attempt_count: (sendable[0]?.attempt_count ?? 0) + 1, last_error: result.error })
      .in('id', sendable.map((r) => r.id));
    return {
      claimed: rows.length,
      sent: 0,
      expired: expired.length,
      suppressed: suppressed.length,
      failed: sendable.length,
      error: result.error,
    };
  }

  await db
    .from('meta_events_outbox')
    .update({ sent_at: now, last_error: null })
    .in('id', sendable.map((r) => r.id));

  return {
    claimed: rows.length,
    sent: sendable.length,
    expired: expired.length,
    suppressed: suppressed.length,
    failed: 0,
  };
}
