// Square payments client — server-only. Replaces lib/stripe.ts for BinGo's
// single-account, card-on-file → auto-charge-at-close model.
//
// Deliberately uses raw `fetch` (not the `square` npm SDK): the SDK pulls Node
// built-ins that don't run on the Cloudflare Workers runtime. Every call here
// is fetch + SubtleCrypto only, so it works on both Node (cron/dev) and Workers.
//
// Auth + config come from env (worker secrets in prod, .secrets/square.env in
// dev): SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_API_BASE, SQUARE_VERSION,
// SQUARE_WEBHOOK_SIGNATURE_KEY.
//
// INVARIANT: every CreatePayment MUST pin location_id = SQUARE_LOCATION_ID
// ("Bingo Auctions", LH36T6WADKGV7). The access token is account-wide and can
// charge any of the owner's 25 Square locations — pinning the location is the
// only thing that keeps auction money on the Bingo account.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normaliseUsZip } from '@/lib/bidder-postal-code-from-card';

const API_BASE = process.env.SQUARE_API_BASE ?? 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION ?? '2026-05-20';

function accessToken(): string {
  const t = process.env.SQUARE_ACCESS_TOKEN;
  if (!t) throw new Error('SQUARE_ACCESS_TOKEN is not set');
  return t;
}

export function squareLocationId(): string {
  const l = process.env.SQUARE_LOCATION_ID;
  if (!l) throw new Error('SQUARE_LOCATION_ID is not set');
  return l;
}

/**
 * Resolve the Square location to charge against (mig 0293).
 *
 * ONE Square account and ONE access token serve any number of locations — a
 * location is just an id passed per transaction, NOT a separate integration or
 * a second API key. So multi-location support is this function, not a new
 * client.
 *
 * Until BinGo added Dodge City (KS) alongside Harrison (AR) there was one
 * location and `location_id` was pinned to a single env var on every payment.
 * That would book every Kansas sale to the Arkansas location, and Square's own
 * reporting, deposit routing and location-level tax all key off it.
 *
 * Falls back to the env var when a warehouse has no mapping, so Harrison keeps
 * working untouched and this is a no-op until someone fills in
 * `warehouses.square_location_id`.
 */
export async function resolveSquareLocationId(
  warehouseSquareLocationId: string | null | undefined,
): Promise<string> {
  const mapped = warehouseSquareLocationId?.trim();
  return mapped && mapped.length > 0 ? mapped : squareLocationId();
}

type SquareError = { category?: string; code?: string; detail?: string; field?: string };

export class SquareApiError extends Error {
  status: number;
  errors: SquareError[];
  constructor(status: number, errors: SquareError[]) {
    const first = errors[0];
    super(first ? `${first.code}: ${first.detail ?? ''}` : `Square API error ${status}`);
    this.name = 'SquareApiError';
    this.status = status;
    this.errors = errors;
  }
}

// Core request helper. Throws SquareApiError on non-2xx so callers can branch on
// .code (e.g. CARD_DECLINED, CVV_FAILURE, GENERIC_DECLINE).
async function squareFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  // Square hard-caps idempotency_key at 45 chars and rejects the whole request
  // with VALUE_TOO_LONG (the 2026-07-02 card-save outage: every CreateCard since
  // the cutover 400'd on a 66-char key). Fail loudly with the key in hand so an
  // over-length key can never ship as a silent prod 400 again.
  const idem = (body as { idempotency_key?: unknown } | undefined)?.idempotency_key;
  if (typeof idem === 'string' && idem.length > 45) {
    throw new Error(
      `square idempotency_key exceeds 45 chars (${idem.length}): ${idem.slice(0, 16)}…`,
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();

  // Parse defensively, and only AFTER res.ok is known. Square's edge (and any
  // proxy in front of it) answers 5xx with a plain-text body — "upstream connect
  // error…" — which is not JSON. Parsing first turned that into a raw
  // SyntaxError, and the auto-charge drain recorded it as a payment failure:
  // the 2026-07-25 incident blocked a bidder and relisted their won lot over a
  // transient 502, on a card that charged fine the night before and the morning
  // after. A gateway blip must surface as a retryable SquareApiError, never as a
  // decline.
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        throw new SquareApiError(res.status, [
          {
            code: 'UPSTREAM_NON_JSON',
            category: 'API_ERROR',
            detail: `HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`,
          },
        ]);
      }
      // 2xx that is not JSON should never happen; fail loudly rather than
      // returning {} and letting a caller read undefined fields as "missing".
      throw new Error(
        `square ${method} ${path}: HTTP ${res.status} body was not JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  if (!res.ok) {
    throw new SquareApiError(res.status, (json.errors as SquareError[]) ?? []);
  }
  return json as T;
}

/**
 * Loose US-centric E.164 normalization; null when the number is unusable.
 * Lives here (not square-sync) because EVERY Square customer call must use
 * it: Square 400s (INVALID_PHONE_NUMBER) on raw digits like "8704141444",
 * and bidders.phone stores whatever the signup/profile form accepted. The
 * 2026-07-06 card-save outage: ensureBidderSquareCustomer passed the raw
 * phone through, so every new signup WITH a phone got a 500 on save-card.
 */
export function normalizePhoneE164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+') && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

// ── Customers ────────────────────────────────────────────────────────────────
// One Square customer per bidder. Stored on bidders.square_customer_id (parallel
// to the dormant stripe_customer_id). reference_id pins it back to our user id.
export async function ensureBidderSquareCustomer(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  email: string | null,
  displayName: string | null,
): Promise<string> {
  const { data: bidder } = await admin
    .from('bidders')
    .select('square_customer_id')
    .eq('id', userId)
    .maybeSingle();
  const existing = (bidder?.square_customer_id as string | null) ?? null;
  if (existing) return existing;

  // Duplicate-safe (2026-07-06): adopt an existing in-store profile matched
  // by email/phone rather than minting a duplicate — see
  // adoptOrCreateSquareCustomer below.
  const { data: contact } = await admin
    .from('bidders')
    .select('phone')
    .eq('id', userId)
    .maybeSingle();
  const { id: customerId } = await adoptOrCreateSquareCustomer({
    userId,
    email,
    displayName,
    phone: (contact?.phone as string | null) ?? null,
  });
  await admin.from('bidders').update({ square_customer_id: customerId }).eq('id', userId);
  return customerId;
}

// ── Card on file ──────────────────────────────────────────────────────────────
// Vault a card token (from the Web Payments SDK / In-App Payments SDK) as a
// card-on-file. Returns the durable card id + non-sensitive display crumbs to
// store on the bidder. Square fires a $0 verification on create.
export type SavedCard = {
  cardId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  // 0436: first 5 digits of card.billing_address.postal_code when it is a US
  // ZIP, else null. Set by createCardOnFile only (not by the card list).
  billingPostalCode?: string | null;
};

// Deterministic ≤45-char idempotency key: SHA-256 of the logical operation id,
// hex-sliced to 45. Same input → same key so retries converge; hashing (rather
// than truncating the input) keeps distinct operations from colliding.
export async function idempotencyKey45(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 45);
}

export async function createCardOnFile(params: {
  customerId: string;
  cardToken: string; // source_id from the SDK tokenization
  userId: string; // for the idempotency key
  verificationToken?: string; // SCA buyer-verification token (3DS), when present
}): Promise<SavedCard> {
  const out = await squareFetch<{
    card: {
      id: string;
      card_brand?: string;
      last_4?: string;
      exp_month?: number;
      exp_year?: number;
      billing_address?: { postal_code?: string; country?: string };
    };
  }>('POST', '/v2/cards', {
    // Hashed: 'card:' + uuid + ':' + full token is way past the 45-char cap
    // (the raw form of this key is what broke every card save since cutover).
    idempotency_key: await idempotencyKey45(`card:${params.userId}:${params.cardToken}`),
    source_id: params.cardToken,
    ...(params.verificationToken ? { verification_token: params.verificationToken } : {}),
    card: { customer_id: params.customerId },
  });
  return {
    cardId: out.card.id,
    brand: out.card.card_brand ?? null,
    last4: out.card.last_4 ?? null,
    expMonth: out.card.exp_month ?? null,
    expYear: out.card.exp_year ?? null,
    billingPostalCode: normaliseUsZip(
      out.card.billing_address?.postal_code,
      out.card.billing_address?.country,
    ),
  };
}

// List a customer's ENABLED cards-on-file. Square's GET /v2/cards excludes
// disabled cards by default. Used to recover from CARD_TOKEN_ALREADY_USED: that
// code means the nonce was already consumed into a saved card, so instead of
// erroring we re-point the bidder at the card that already exists.
export async function listEnabledCustomerCards(customerId: string): Promise<SavedCard[]> {
  const out = await squareFetch<{
    cards?: Array<{
      id: string;
      enabled?: boolean;
      card_brand?: string;
      last_4?: string;
      exp_month?: number;
      exp_year?: number;
    }>;
  }>('GET', `/v2/cards?customer_id=${encodeURIComponent(customerId)}`);
  return (out.cards ?? [])
    .filter((c) => c.enabled !== false)
    .map((c) => ({
      cardId: c.id,
      brand: c.card_brand ?? null,
      last4: c.last_4 ?? null,
      expMonth: c.exp_month ?? null,
      expYear: c.exp_year ?? null,
    }));
}

// Disable a stored card (on card-replace, or bidder remove-card).
export async function disableCard(cardId: string): Promise<void> {
  await squareFetch('POST', `/v2/cards/${cardId}/disable`);
}

// ── Payments ──────────────────────────────────────────────────────────────────
// Charge a stored card-on-file with the buyer NOT present (merchant-initiated).
// idempotencyKey MUST be invoice-scoped so retries/double-fires converge on one
// payment. location_id is always pinned (see file-top INVARIANT).
// What Square knows about the card a payment actually ran on. Square returns
// these ONLY on Payments API responses — CreateCard (the vaulting call) does
// not include them — so a bidder's card type is knowable only once we've tried
// to charge it. `prepaidType` is the one that answers "is this a prepaid card",
// which is otherwise pure guesswork from the BIN or the expiry date.
export type PaymentCardFacts = {
  cardType: string | null; // CREDIT | DEBIT | UNKNOWN
  prepaidType: string | null; // PREPAID | NOT_PREPAID | UNKNOWN
  brand: string | null;
  last4: string | null;
};

export type PaymentResult = {
  paymentId: string;
  status: string; // COMPLETED | APPROVED | PENDING | FAILED | CANCELED
  cardFacts?: PaymentCardFacts | null;
  // 0287: Square's processing fee for this payment, in cents, and the amount
  // Square will actually deposit (captured − fee). Both are null until the
  // payment SETTLES — Square populates processing_fee asynchronously, typically
  // the next business day — which is why the fee backfill sweep exists rather
  // than trusting the value present at charge time.
  processingFeeCents?: number | null;
  netCents?: number | null;
  approvedCents?: number | null;
};

// Square returns processing_fee as an array (a payment can carry more than one
// fee entry). Sum the amounts; return null when Square hasn't reported any yet
// so "unsettled" stays distinguishable from a genuine zero fee.
type SquarePaymentPayload = {
  id: string;
  status: string;
  amount_money?: { amount?: number } | null;
  approved_money?: { amount?: number } | null;
  processing_fee?: Array<{ amount_money?: { amount?: number } | null }> | null;
  card_details?: {
    card?: {
      card_brand?: string;
      last_4?: string;
      card_type?: string;
      prepaid_type?: string;
    } | null;
  } | null;
};

// Pull the card facts off a payment payload. Returns null when Square reported
// nothing useful, so "we never learned" stays distinct from "UNKNOWN".
export function extractCardFacts(
  payment: Pick<SquarePaymentPayload, 'card_details'> | null | undefined,
): PaymentCardFacts | null {
  const c = payment?.card_details?.card;
  if (!c) return null;
  const facts: PaymentCardFacts = {
    cardType: c.card_type ?? null,
    prepaidType: c.prepaid_type ?? null,
    brand: c.card_brand ?? null,
    last4: c.last_4 ?? null,
  };
  return facts.cardType || facts.prepaidType ? facts : null;
}

export function extractProcessingFeeCents(
  payment: Pick<SquarePaymentPayload, 'processing_fee'> | null | undefined,
): number | null {
  const entries = payment?.processing_fee;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let total = 0;
  let sawAmount = false;
  for (const e of entries) {
    const amt = e?.amount_money?.amount;
    if (typeof amt === 'number') {
      total += amt;
      sawAmount = true;
    }
  }
  return sawAmount ? total : null;
}

export async function chargeCardOnFile(params: {
  customerId: string;
  cardId: string;
  amountCents: number;
  idempotencyKey: string;
  referenceId?: string; // our invoice id
  note?: string;
  /**
   * 0293: the warehouse's Square location id, when the invoice's warehouse has
   * one mapped. Omit / null → the SQUARE_LOCATION_ID env var, i.e. the
   * single-location behaviour every existing caller had.
   */
  squareLocationId?: string | null;
}): Promise<PaymentResult> {
  const locationId = await resolveSquareLocationId(params.squareLocationId);
  const out = await squareFetch<{ payment: SquarePaymentPayload }>(
    'POST',
    '/v2/payments',
    {
      idempotency_key: params.idempotencyKey,
      source_id: params.cardId,
      customer_id: params.customerId,
      location_id: locationId,
      amount_money: { amount: params.amountCents, currency: 'USD' },
      autocomplete: true,
      reference_id: params.referenceId?.slice(0, 40),
      note: params.note?.slice(0, 500),
    },
  );
  return {
    paymentId: out.payment.id,
    status: out.payment.status,
    cardFacts: extractCardFacts(out.payment),
  };
}

// Fetch one payment by id. Returns null on 404 (unknown id). Used by the
// reconcile-before-charge path to check whether a recorded square_payment_id
// actually completed.
// 0287: also returns the settled processing fee + net deposit amount when Square
// has reported them, so the fee backfill sweep can reconcile deposits.
export async function getPayment(paymentId: string): Promise<PaymentResult | null> {
  try {
    const out = await squareFetch<{ payment: SquarePaymentPayload }>(
      'GET',
      `/v2/payments/${encodeURIComponent(paymentId)}`,
    );
    const fee = extractProcessingFeeCents(out.payment);
    const captured =
      out.payment.approved_money?.amount ?? out.payment.amount_money?.amount ?? null;
    return {
      paymentId: out.payment.id,
      status: out.payment.status,
      processingFeeCents: fee,
      approvedCents: captured,
      netCents: fee != null && captured != null ? captured - fee : null,
      cardFacts: extractCardFacts(out.payment),
    };
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) return null;
    throw err;
  }
}

// Find a COMPLETED/APPROVED payment already made for an invoice, matched by
// reference_id (= our invoice id). This is how we recover from the case where a
// charge actually succeeded at Square but the success never landed on our side
// — the CreatePayment call timed out, or a second attempt reused the invoice's
// idempotency key and errored (the 2026-07-08 IDEMPOTENCY_KEY_REUSED incident).
// ListPayments has no reference_id filter, so we scan a bounded window from
// `sinceIso` and match client-side. Returns the payment or null.
export async function findCompletedPaymentForInvoice(params: {
  invoiceId: string;
  sinceIso: string; // typically invoice.created_at minus a small buffer
}): Promise<PaymentResult | null> {
  const location = squareLocationId();
  let cursor: string | undefined;
  // Cap pages so a busy location can't spin the worker; the window is narrow.
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({
      location_id: location,
      begin_time: params.sinceIso,
      sort_order: 'ASC',
      limit: '100',
    });
    if (cursor) qs.set('cursor', cursor);
    const out = await squareFetch<{
      payments?: Array<{ id: string; status: string; reference_id?: string }>;
      cursor?: string;
    }>('GET', `/v2/payments?${qs.toString()}`);
    for (const p of out.payments ?? []) {
      if (
        p.reference_id === params.invoiceId &&
        (p.status === 'COMPLETED' || p.status === 'APPROVED')
      ) {
        return { paymentId: p.id, status: p.status };
      }
    }
    if (!out.cursor) break;
    cursor = out.cursor;
  }
  return null;
}

// ── Refunds ───────────────────────────────────────────────────────────────────
export type RefundResult = { refundId: string; status: string };

export async function refundPayment(params: {
  paymentId: string;
  amountCents: number;
  idempotencyKey: string;
  reason?: string;
}): Promise<RefundResult> {
  const out = await squareFetch<{ refund: { id: string; status: string } }>(
    'POST',
    '/v2/refunds',
    {
      idempotency_key: params.idempotencyKey,
      payment_id: params.paymentId,
      amount_money: { amount: params.amountCents, currency: 'USD' },
      reason: params.reason?.slice(0, 192),
    },
  );
  return { refundId: out.refund.id, status: out.refund.status };
}

// ── Webhook signature verification ────────────────────────────────────────────
// Square signs with HMAC-SHA256 over (notificationUrl + rawBody) using the
// webhook subscription's signature key, base64-encoded, in the
// x-square-hmacsha256-signature header. SubtleCrypto keeps this Workers-safe.
export async function verifySquareWebhook(
  rawBody: string,
  signatureHeader: string | null,
  notificationUrl: string,
): Promise<boolean> {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key || !signatureHeader) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(notificationUrl + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Constant-time-ish compare (length guard + char accumulation).
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// ── Directory sync + Loyalty (mig 0236) ─────────────────────────────────────
// Marketing bridge to the owner's wider Square account (brick-and-mortar
// stores + Square Loyalty). See lib/cron/square-sync.ts for the sweep.

/** Sparse-update a customer's contact fields (used to backfill phone/email). */
export async function updateSquareCustomer(
  customerId: string,
  fields: { givenName?: string | null; email?: string | null; phone?: string | null },
): Promise<void> {
  await squareFetch('PUT', `/v2/customers/${customerId}`, {
    given_name: fields.givenName ?? undefined,
    email_address: fields.email ?? undefined,
    // Normalized or omitted — a raw phone 400s the whole update.
    phone_number: normalizePhoneE164(fields.phone ?? null) ?? undefined,
  });
}

/** Create a bare customer (no card) so cardless bidders reach the directory. */
export async function createSquareCustomer(params: {
  userId: string;
  email: string | null;
  displayName: string | null;
  phone: string | null;
}): Promise<string> {
  const created = await squareFetch<{ customer: { id: string } }>('POST', '/v2/customers', {
    idempotency_key: `cust:${params.userId}`, // same key shape as ensureBidderSquareCustomer
    given_name: params.displayName ?? undefined,
    email_address: params.email ?? undefined,
    // Normalized or omitted — Square rejects raw digits (INVALID_PHONE_NUMBER),
    // and a bad phone must never block creating the customer itself.
    phone_number: normalizePhoneE164(params.phone) ?? undefined,
    reference_id: params.userId,
  });
  return created.customer.id;
}

/**
 * Duplicate-safe profile resolution (owner concern, 2026-07-06): a local
 * bidder is often ALREADY in the Square directory from shopping in-store,
 * and Square does NOT dedupe on create. Search by exact email, then exact
 * phone, and ADOPT the existing store profile instead of minting a second
 * one — the person keeps one record with both in-store and auction history.
 * Only genuinely-new people get a fresh profile.
 */
export async function adoptOrCreateSquareCustomer(params: {
  userId: string;
  email: string | null;
  displayName: string | null;
  phone: string | null;
}): Promise<{ id: string; adopted: boolean }> {
  // Search is best-effort: a search failure must degrade to "create a fresh
  // profile", never block the caller (card saves go through here — the
  // 2026-07-06 outage was a raw-digit phone 400ing this search and killing
  // every save-card for new signups with a phone).
  const searchExact = async (filter: Record<string, unknown>) => {
    try {
      const res = await squareFetch<{ customers?: Array<{ id: string }> }>(
        'POST',
        '/v2/customers/search',
        { query: { filter }, limit: 2 },
      );
      return res.customers?.[0]?.id ?? null;
    } catch (err) {
      console.error('[square] customer search failed (continuing to create):', (err as Error).message);
      return null;
    }
  };

  // Square requires E.164 everywhere a phone appears; unusable numbers are
  // simply dropped (the customer still gets created/adopted without one).
  const phone = normalizePhoneE164(params.phone);

  let found: string | null = null;
  if (params.email) {
    found = await searchExact({ email_address: { exact: params.email } });
  }
  if (!found && phone) {
    found = await searchExact({ phone_number: { exact: phone } });
  }

  if (found) {
    // Adopt: tag the store profile back to our bidder + freshen contact info.
    await squareFetch('PUT', `/v2/customers/${found}`, {
      reference_id: params.userId,
      given_name: params.displayName ?? undefined,
      email_address: params.email ?? undefined,
      phone_number: phone ?? undefined,
    });
    return { id: found, adopted: true };
  }

  const id = await createSquareCustomer(params);
  return { id, adopted: false };
}

/** Find-or-create the named customer group; returns its id. */
export async function ensureCustomerGroup(name: string): Promise<string> {
  const list = await squareFetch<{ groups?: Array<{ id: string; name: string }> }>(
    'GET',
    '/v2/customers/groups',
  );
  const existing = (list.groups ?? []).find((g) => g.name === name);
  if (existing) return existing.id;
  const created = await squareFetch<{ group: { id: string } }>('POST', '/v2/customers/groups', {
    idempotency_key: await idempotencyKey45(`group:${name}`),
    group: { name },
  });
  return created.group.id;
}

/** Idempotent group membership (Square PUT semantics). */
export async function addCustomerToGroup(customerId: string, groupId: string): Promise<void> {
  await squareFetch('PUT', `/v2/customers/${customerId}/groups/${groupId}`);
}

/** The account's main loyalty program, or null when none is active. */
export async function getMainLoyaltyProgram(): Promise<{ id: string; status: string } | null> {
  try {
    const res = await squareFetch<{ program?: { id: string; status: string } }>(
      'GET',
      '/v2/loyalty/programs/main',
    );
    return res.program ?? null;
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) return null;
    throw err;
  }
}

/** Find a loyalty account by phone or enroll one. Phone must be E.164. */
export async function findOrCreateLoyaltyAccount(
  programId: string,
  phoneE164: string,
): Promise<string> {
  const search = await squareFetch<{ loyalty_accounts?: Array<{ id: string }> }>(
    'POST',
    '/v2/loyalty/accounts/search',
    { query: { mappings: [{ phone_number: phoneE164 }] }, limit: 1 },
  );
  const found = search.loyalty_accounts?.[0];
  if (found) return found.id;
  const created = await squareFetch<{ loyalty_account: { id: string } }>(
    'POST',
    '/v2/loyalty/accounts',
    {
      idempotency_key: await idempotencyKey45(`loyacct:${phoneE164}`),
      loyalty_account: { program_id: programId, mapping: { phone_number: phoneE164 } },
    },
  );
  return created.loyalty_account.id;
}

/**
 * Accumulate points for a Square payment — the program's own earn rules
 * decide how many. idempotency key derives from the invoice so retries
 * can never double-award.
 */
export async function accumulateLoyaltyPoints(params: {
  accountId: string;
  paymentId: string;
  invoiceId: string;
}): Promise<void> {
  await squareFetch('POST', `/v2/loyalty/accounts/${params.accountId}/accumulate`, {
    idempotency_key: `loy:${params.invoiceId}`, // 'loy:'+uuid = 40 chars
    accumulate_points: { payment_id: params.paymentId },
    location_id: squareLocationId(),
  });
}

// ── Loyalty redemption (mig 0237, Phase 2) ──────────────────────────────────
// Bidders convert points → BinGo credit from their profile. The reward's
// fixed dollar value comes from the program's reward tiers.

export type LoyaltyTier = {
  id: string;
  points: number;
  name: string;
  /** Fixed dollar value in cents, or null when the tier isn't a fixed-amount
   *  discount (percent-off / catalog-rule tiers redeem in-store only). */
  fixedCents: number | null;
};

export type LoyaltyProgramFull = {
  id: string;
  status: string;
  /** e.g. { one: 'Point', other: 'Points' } */
  terminology: { one: string; other: string } | null;
  tiers: LoyaltyTier[];
};

export async function getLoyaltyProgramFull(): Promise<LoyaltyProgramFull | null> {
  try {
    const res = await squareFetch<{
      program?: {
        id: string;
        status: string;
        terminology?: { one?: string; other?: string };
        reward_tiers?: Array<{
          id: string;
          points: number;
          name?: string;
          definition?: {
            discount_type?: string;
            fixed_discount_money?: { amount?: number };
            percentage_discount?: string;
          };
        }>;
      };
    }>('GET', '/v2/loyalty/programs/main');
    const p = res.program;
    if (!p) return null;
    return {
      id: p.id,
      status: p.status,
      terminology:
        p.terminology?.one && p.terminology?.other
          ? { one: p.terminology.one, other: p.terminology.other }
          : null,
      tiers: (p.reward_tiers ?? []).map((t) => ({
        id: t.id,
        points: t.points,
        name: t.name ?? `${t.points} points`,
        fixedCents:
          t.definition?.discount_type === 'FIXED_AMOUNT' &&
          typeof t.definition?.fixed_discount_money?.amount === 'number'
            ? t.definition.fixed_discount_money.amount
            : null,
      })),
    };
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getLoyaltyBalance(accountId: string): Promise<number> {
  const res = await squareFetch<{ loyalty_account?: { balance?: number } }>(
    'GET',
    `/v2/loyalty/accounts/${accountId}`,
  );
  return res.loyalty_account?.balance ?? 0;
}

/** Create a reward — LOCKS the tier's points on the account. */
export async function createLoyaltyReward(params: {
  accountId: string;
  tierId: string;
  redemptionId: string;
}): Promise<string> {
  const res = await squareFetch<{ reward: { id: string } }>('POST', '/v2/loyalty/rewards', {
    idempotency_key: await idempotencyKey45(`lrw-create:${params.redemptionId}`),
    reward: { loyalty_account_id: params.accountId, reward_tier_id: params.tierId },
  });
  return res.reward.id;
}

/** Redeem (consume) a created reward — points are spent for good. */
export async function redeemLoyaltyReward(rewardId: string, redemptionId: string): Promise<void> {
  await squareFetch('POST', `/v2/loyalty/rewards/${rewardId}/redeem`, {
    idempotency_key: await idempotencyKey45(`lrw-redeem:${redemptionId}`),
    location_id: squareLocationId(),
  });
}

/** Delete an un-redeemed reward — RETURNS the locked points (rollback). */
export async function deleteLoyaltyReward(rewardId: string): Promise<void> {
  await squareFetch('DELETE', `/v2/loyalty/rewards/${rewardId}`);
}
