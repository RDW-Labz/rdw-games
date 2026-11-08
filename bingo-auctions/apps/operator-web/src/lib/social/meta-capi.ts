// Meta Conversions API — server-side conversion events.
//
// Sibling of meta-graph.ts (Page/IG publishing) and deliberately separate: that
// file posts CONTENT as the business, this one reports BEHAVIOUR about people.
// They need different credentials, they fail differently, and mixing them would
// put a Pixel token in the code path that can post to the Page.
//
// ── WHY SERVER-SIDE AT ALL ───────────────────────────────────────────────────
// A browser Pixel cannot see most of what matters here. Bidding happens largely
// in the native app, and `place_bid` is a PostgREST RPC with no web request to
// hang a Pixel event on. iOS ATT and ad blockers drop a further slice of the
// browser events that do exist. So the server is the only place with a complete
// view, and the Pixel becomes an addition rather than the source of truth.
//
// ── DEDUPLICATION ────────────────────────────────────────────────────────────
// Where both fire for one action (a purchase completed in the browser), Meta
// collapses them when the browser and the server send the SAME `event_id` with
// the same `event_name`. Our ids come from the row that caused the event —
// `invoice:<uuid>`, `firstbid:<uuid>` — so they are stable across retries and
// identical on both sides without any coordination.
//
// ── HASHING IS NOT OPTIONAL ──────────────────────────────────────────────────
// Meta requires SHA-256 of normalised contact fields. Sending plaintext is a
// policy violation, so `hashPii` is the only way user data enters a payload
// here, and the raw values never leave this module or reach a log line.

import { createHash } from 'node:crypto';
import { META_DATASET_ID } from './meta-dataset';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta rejects anything older than this, so the drain drops rather than
 *  retries a stale row forever. */
export const MAX_EVENT_AGE_DAYS = 7;

export interface CapiCredentials {
  pixelId: string;
  token: string;
  /** Echoed back by Meta's Test Events tab; unset in normal operation. */
  testEventCode: string | null;
}

/**
 * Missing credentials are a CONFIGURATION state, not an error — same posture as
 * readMetaCredentials. The drain has to skip cleanly and say so, because a cron
 * that throws every minute until someone finishes a console task is its own
 * incident.
 *
 * Only the TOKEN can be missing now. The dataset id is a literal (see
 * meta-dataset.ts), so "not configured" means exactly one thing, and the skip
 * reason below names it.
 *
 * The CAPI token is read separately from META_PAGE_ACCESS_TOKEN, but falls back
 * to it: a system-user token with ads_management can do both, and requiring two
 * secrets to start would be a setup step with no security benefit. Setting
 * META_CAPI_TOKEN later narrows the blast radius without a code change.
 */
export function readCapiCredentials(): CapiCredentials | null {
  const pixelId = process.env.META_PIXEL_ID?.trim() || META_DATASET_ID;
  const token =
    process.env.META_CAPI_TOKEN?.trim() || process.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (!pixelId || !token) return null;
  return {
    pixelId,
    token,
    testEventCode: process.env.META_CAPI_TEST_EVENT_CODE?.trim() || null,
  };
}

/**
 * Normalise then SHA-256, per Meta's matching spec: trim, lowercase, and for
 * phones strip everything that is not a digit. Normalisation is not cosmetic —
 * an unnormalised hash simply fails to match any user, so the event is accepted
 * and then attributed to nobody, which looks like "the API works but ads do not
 * convert".
 *
 * Returns null for empty input so callers can omit the key entirely; Meta reads
 * a hash of the empty string as a real (and permanently unmatchable) value.
 */
export function hashPii(value: string | null | undefined, kind: 'email' | 'phone' = 'email'): string | null {
  if (!value) return null;
  const normalised =
    kind === 'phone' ? value.replace(/\D/g, '') : value.trim().toLowerCase();
  if (!normalised) return null;
  return createHash('sha256').update(normalised).digest('hex');
}

export interface CapiEvent {
  eventName: 'Purchase' | 'Lead' | 'CompleteRegistration';
  /** Shared with the Pixel for dedup. */
  eventId: string;
  occurredAt: Date;
  email?: string | null;
  phone?: string | null;
  /** External id (our bidder uuid) — matches repeat visitors across devices
   *  even when we have no contact details. Meta expects it hashed too. */
  externalId?: string | null;
  valueCents?: number | null;
  /** Meta's own browser cookie (_fbp) and ad-click cookie (_fbc), captured by
   *  MetaAttribution and stored on the bidder (mig 0341). Sent RAW — Meta looks
   *  these up verbatim. fbc is the one that earns click attribution; fbp alone
   *  improves person-matching but credits no campaign. */
  fbp?: string | null;
  fbc?: string | null;
}

/** One event in Meta's wire shape. Exported for tests: the payload is the
 *  contract, and it is easier to get subtly wrong than to notice. */
export function toCapiPayload(e: CapiEvent): Record<string, unknown> {
  const userData: Record<string, string> = {};
  const em = hashPii(e.email, 'email');
  if (em) userData.em = em;
  const ph = hashPii(e.phone, 'phone');
  if (ph) userData.ph = ph;
  const ext = hashPii(e.externalId, 'email');
  if (ext) userData.external_id = ext;

  // NOT hashed, and that is not an oversight. fbp/fbc are opaque identifiers
  // Meta itself minted in that browser; it looks them up verbatim, so hashing
  // them would guarantee a miss. Hashing applies to values that were personal
  // BEFORE Meta saw them — email, phone, our bidder id.
  //
  // fbc is what actually earns click attribution: it carries the fbclid from
  // the ad landing. Without it Meta matches the person but credits no campaign,
  // which reads in Ads Manager as a campaign that did not work.
  if (e.fbp) userData.fbp = e.fbp;
  if (e.fbc) userData.fbc = e.fbc;

  const payload: Record<string, unknown> = {
    event_name: e.eventName,
    event_id: e.eventId,
    // Seconds, not milliseconds. Meta silently treats a millisecond value as a
    // date far in the future and drops the event.
    event_time: Math.floor(e.occurredAt.getTime() / 1000),
    // 'website', not 'app'. This is a WEB dataset, and Meta validates
    // action_source against what else the event carries: an 'app' event is
    // expected to arrive with app_data / a mobile advertiser id, and ours
    // carries only hashed em/ph/external_id. 'website' is the value that
    // matches both the dataset type and the identifiers we actually send.
    //
    // 'system_generated' is arguably more literal for Purchase, which is
    // raised by the auto-charge worker at lot close rather than by anyone
    // clicking anything. It is deliberately not used: it is a narrower path
    // with weaker matching support, and splitting action_source per event type
    // would make the three conversions incomparable in reporting for no gain.
    action_source: 'website',
    user_data: userData,
  };

  if (e.valueCents != null) {
    payload.custom_data = { currency: 'USD', value: (e.valueCents / 100).toFixed(2) };
  }
  return payload;
}

export type CapiResult =
  | { ok: true; received: number }
  | { ok: false; error: string };

/**
 * Send a batch. Meta accepts up to 1000 events per call.
 *
 * Graph reports failures as HTTP 200 with an `error` body about as often as it
 * uses a 4xx — the same trap meta-graph.ts documents — so both are handled or
 * failures read as successes and the outbox drains into nothing.
 */
export async function sendCapiEvents(
  events: CapiEvent[],
  creds: CapiCredentials,
): Promise<CapiResult> {
  if (events.length === 0) return { ok: true, received: 0 };

  const body: Record<string, string> = {
    data: JSON.stringify(events.map(toCapiPayload)),
    access_token: creds.token,
  };
  if (creds.testEventCode) body.test_event_code = creds.testEventCode;

  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${creds.pixelId}/events`, {
      method: 'POST',
      body: new URLSearchParams(body),
    });
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }

  // Meta's top-level `error.message` is almost always the generic "Invalid
  // parameter". Everything that identifies WHICH parameter is in the sibling
  // fields, so capturing only `message` leaves the queue full of rows that say
  // nothing. Learned the hard way: 13 events failed with "Invalid parameter"
  // and the reason was unrecoverable from the stored error.
  type GraphReply = {
    events_received?: number;
    error?: {
      message?: string;
      error_user_title?: string;
      error_user_msg?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  };
  let parsed: GraphReply | null = null;
  try {
    // NB: not `as typeof parsed` — TS narrows that to `null` from the
    // initializer, and every field read below then fails on type `never`.
    parsed = (await res.json()) as GraphReply;
  } catch {
    return { ok: false, error: `unparseable response (HTTP ${res.status})` };
  }

  if (parsed?.error) {
    const e = parsed.error;
    // error_user_msg is the human-readable "what you did wrong"; the codes let
    // us look up a cause Meta did not spell out. Joined into one string because
    // the outbox stores a single last_error column and a truncated reason is
    // worse than a long one.
    const detail = [
      e.error_user_title,
      e.error_user_msg,
      e.code != null ? `code ${e.code}` : null,
      e.error_subcode != null ? `subcode ${e.error_subcode}` : null,
      e.fbtrace_id ? `fbtrace ${e.fbtrace_id}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    return {
      ok: false,
      error: detail ? `${e.message ?? 'Graph error'}: ${detail}` : (e.message ?? 'unknown Graph error'),
    };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  return { ok: true, received: parsed?.events_received ?? events.length };
}
