// Server-only EasyPost client wrapper.
//
// Usage policy:
//   - Bidder app never calls EasyPost directly. It posts addresses to
//     our /api/shipping/* routes; we call EasyPost server-side using the
//     EASYPOST_API_KEY env var.
//   - One platform account for v1 (this file). The schema in
//     operator_shipping_config has an easypost_account_token field
//     reserved for the per-operator child-account flow we'll add in v2.
//
// We deliberately avoid the official `@easypost/api` npm package — it
// pulls in axios + Node-only deps that don't play well with the
// Cloudflare Workers runtime we deploy to via @opennextjs. EasyPost's
// REST API is small enough to wrap by hand with fetch().
//
// Env vars consumed:
//   EASYPOST_API_KEY  — required.  EZTK_ for test, EZAK_ for production.
//                       Sign up at https://www.easypost.com/signup.

const EASYPOST_API_BASE = 'https://api.easypost.com/v2';

// ───────────────────────────────────────────────────────────────────────
// Types — mirror the EasyPost REST API shapes we touch. Trimmed to the
// fields we actually consume; the API returns more we ignore.
// ───────────────────────────────────────────────────────────────────────

export type Address = {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string; // defaults to 'US' if omitted
  phone?: string;
  email?: string;
};

export type Parcel = {
  length: number; // inches
  width: number;
  height: number;
  weight: number; // ounces
};

export type Rate = {
  id: string; // EasyPost rate id — pass to buyLabel
  carrier: string; // 'USPS', 'UPS', 'FedEx', 'DHL', etc.
  service: string; // 'Priority', 'Ground', 'Express', etc.
  rate: string; // dollars-cents string, e.g. "8.42"
  currency: string; // 'USD'
  delivery_days: number | null;
  delivery_date: string | null;
  est_delivery_days: number | null;
};

export type Shipment = {
  id: string;
  rates: Rate[];
  selected_rate?: Rate | null;
  tracking_code?: string | null;
  postage_label?: { label_url: string; label_pdf_url?: string } | null;
};

// ───────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────

export class EasyPostError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly raw: unknown;

  constructor(message: string, status: number, code: string | null, raw: unknown) {
    super(message);
    this.name = 'EasyPostError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Low-level transport
// ───────────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.EASYPOST_API_KEY;
  if (!key) {
    throw new EasyPostError(
      'EASYPOST_API_KEY env var not set. Sign up at https://www.easypost.com/signup and add the test key (EZTK_…) to .env.local. Or set EASYPOST_API_KEY=STUB to use the deterministic local fallback for development.',
      0,
      'config_missing',
      null,
    );
  }
  return key;
}

// Stub mode: when EASYPOST_API_KEY is literally "STUB" (or unset and the
// caller opted into stub) we return deterministic fake rates so the
// rest of the platform can be developed and tested without a live
// EasyPost account.
//
// The shape matches the real API responses just enough that consumers
// don't have to branch on stub-vs-real. Stub shipment ids are
// recognizable (prefixed `shp_stub_`) so support staff can spot them
// in logs.
export function isStubMode(): boolean {
  const key = process.env.EASYPOST_API_KEY ?? '';
  return key === 'STUB' || key === '';
}

function stubShipment(_args: {
  from: Address;
  to: Address;
  parcel: Parcel;
}): Shipment {
  // _args is unused — the stub returns deterministic rates regardless of
  // input addresses/parcel dims. Kept on the signature so call sites
  // don't need to branch isStubMode().
  const ts = Date.now();
  // Two faux rates so the cheapest-rate picker has something to do.
  const rates: Rate[] = [
    {
      id: `rate_stub_priority_${ts}`,
      carrier: 'USPS',
      service: 'Priority',
      rate: '9.99',
      currency: 'USD',
      delivery_days: 3,
      delivery_date: null,
      est_delivery_days: 3,
    },
    {
      id: `rate_stub_ground_${ts}`,
      carrier: 'USPS',
      service: 'GroundAdvantage',
      rate: '6.49',
      currency: 'USD',
      delivery_days: 5,
      delivery_date: null,
      est_delivery_days: 5,
    },
  ];
  return {
    id: `shp_stub_${ts}`,
    rates,
    selected_rate: null,
    tracking_code: null,
    postage_label: null,
  };
}

function stubBuyLabel(args: { shipmentId: string; rateId: string }): Shipment {
  // 1-page stub PDF — just a data URL that says STUB LABEL. We use a
  // deterministic data URL so the buy-label route can record it as a
  // valid URL. In real use the label URL points at a server-hosted PDF.
  // The bidder's invoice page never sees the label URL; only the
  // operator's queue does, and the queue UI surfaces it via our proxy
  // route so the data URL flows through fine.
  return {
    id: args.shipmentId,
    rates: [],
    selected_rate: {
      id: args.rateId,
      carrier: 'USPS',
      service: args.rateId.includes('ground') ? 'GroundAdvantage' : 'Priority',
      rate: args.rateId.includes('ground') ? '6.49' : '9.99',
      currency: 'USD',
      delivery_days: args.rateId.includes('ground') ? 5 : 3,
      delivery_date: null,
      est_delivery_days: args.rateId.includes('ground') ? 5 : 3,
    },
    tracking_code: `STUB${Date.now()}`,
    postage_label: {
      label_url: STUB_LABEL_DATA_URL,
      label_pdf_url: STUB_LABEL_DATA_URL,
    },
  };
}

// Tiny single-page PDF (data URL) so the buy-label flow has something
// concrete to mirror into Supabase Storage even in stub mode. Hand-
// crafted minimal PDF — renders the word "STUB LABEL" centered on a
// US-letter page.
const STUB_LABEL_DATA_URL =
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjE8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+Pj4+Pj4vQ29udGVudHMgNCAwIFI+PgplbmRvYmoKNCAwIG9iago8PC9MZW5ndGggNTU+PnN0cmVhbQpCVAovRjEgMjQgVGYKMjAwIDQwMCBUZAooU1RVQiBMQUJFTCkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTA5IDAwMDAwIG4gCjAwMDAwMDAyMzEgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDUvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozMzcKJSVFT0YK';

async function easypostFetch<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const url = `${EASYPOST_API_BASE}${path}`;
  // EasyPost uses HTTP Basic auth with the API key as username + blank password.
  const authHeader = `Basic ${Buffer.from(`${getApiKey()}:`).toString('base64')}`;

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errEnvelope = (parsed as { error?: { message?: string; code?: string } } | null)?.error;
    const message = errEnvelope?.message ?? `EasyPost ${path} returned ${res.status}`;
    const code = errEnvelope?.code ?? null;
    throw new EasyPostError(message, res.status, code, parsed);
  }

  return parsed as T;
}

// ───────────────────────────────────────────────────────────────────────
// High-level API
// ───────────────────────────────────────────────────────────────────────

// Verify a bidder-supplied address. Returns the canonical form (corrected
// casing, ZIP+4 if available) or throws on undeliverable. We do this
// pre-checkout so the bidder fixes typos before being charged.
//
// Stub mode: returns the input unchanged. Real EasyPost normalizes (e.g.
// 'St' → 'St.', adds ZIP+4) — local dev doesn't get that benefit.
export async function verifyAddress(addr: Address): Promise<Address> {
  if (isStubMode()) {
    return { ...addr, country: addr.country ?? 'US' };
  }
  const body = {
    address: {
      ...addr,
      country: addr.country ?? 'US',
      verify: ['delivery'],
    },
  };
  const res = await easypostFetch<{
    id: string;
    name?: string;
    company?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
    email?: string;
    verifications?: {
      delivery?: {
        success: boolean;
        errors?: Array<{ field: string; message: string }>;
        details?: Record<string, unknown>;
      };
    };
  }>('/addresses', { method: 'POST', body });

  const delivery = res.verifications?.delivery;
  if (delivery && delivery.success === false) {
    const firstErr = delivery.errors?.[0];
    throw new EasyPostError(
      firstErr?.message ?? 'Address could not be verified',
      400,
      'address_undeliverable',
      delivery,
    );
  }

  return {
    name: res.name,
    company: res.company,
    street1: res.street1,
    street2: res.street2,
    city: res.city,
    state: res.state,
    zip: res.zip,
    country: res.country,
    phone: res.phone,
    email: res.email,
  };
}

// Create a Shipment and return its available rates. The shipment id +
// chosen rate id are persisted on the invoice so buyLabel doesn't have
// to re-quote.
//
// Stub mode: returns two deterministic fake rates (USPS Priority $9.99
// and GroundAdvantage $6.49) so the full bidder/operator flow can be
// exercised without an EasyPost account.
export async function quoteRates(args: {
  from: Address;
  to: Address;
  parcel: Parcel;
}): Promise<Shipment> {
  if (isStubMode()) {
    return stubShipment(args);
  }
  const body = {
    shipment: {
      from_address: { ...args.from, country: args.from.country ?? 'US' },
      to_address: { ...args.to, country: args.to.country ?? 'US' },
      parcel: args.parcel,
      // We don't pre-filter carriers; let the operator/bidder see what's
      // available and pick. Most BinGo Auctions shipments will be USPS-eligible.
    },
  };
  return easypostFetch<Shipment>('/shipments', { method: 'POST', body });
}

// Buy a label against an existing shipment + chosen rate. EasyPost
// returns the label URL (PDF) and the carrier tracking number.
//
// Stub mode: returns a faux Shipment with a tiny inline PDF (data URL)
// so the operator queue flow has something to download for QA without
// a real EasyPost account.
export async function buyLabel(args: {
  shipmentId: string;
  rateId: string;
}): Promise<Shipment> {
  if (isStubMode()) {
    return stubBuyLabel(args);
  }
  return easypostFetch<Shipment>(`/shipments/${args.shipmentId}/buy`, {
    method: 'POST',
    body: { rate: { id: args.rateId } },
  });
}

// Refund an unused label (the carrier hasn't scanned it). EasyPost
// processes refunds asynchronously; the return shape is the shipment
// with refund_status='submitted'.
export async function refundLabel(shipmentId: string): Promise<Shipment> {
  return easypostFetch<Shipment>(`/shipments/${shipmentId}/refund`, {
    method: 'POST',
  });
}

// Poll the tracker. Use sparingly — EasyPost has rate limits; prefer
// webhooks (added in v2) for real-time updates.
export async function getTracker(trackingCode: string, carrier?: string): Promise<{
  tracking_code: string;
  status: string; // 'pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'error'
  est_delivery_date?: string;
  carrier?: string;
}> {
  // The tracker lookup by code + carrier is the deterministic path; using
  // just code requires an index scan. We pass carrier when we have it.
  const search = new URLSearchParams({ tracking_code: trackingCode });
  if (carrier) search.set('carrier', carrier);
  const res = await easypostFetch<{
    trackers: Array<{ tracking_code: string; status: string; est_delivery_date?: string; carrier?: string }>;
  }>(`/trackers?${search.toString()}`);
  const t = res.trackers[0];
  if (!t) {
    throw new EasyPostError('Tracker not found', 404, 'tracker_not_found', res);
  }
  return t;
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

// Convert a dollars-string rate ("8.42") to cents (842). EasyPost returns
// strings to avoid float arithmetic on currency.
export function rateDollarsToCents(rate: string): number {
  const n = Math.round(Number(rate) * 100);
  if (!Number.isFinite(n) || n < 0) {
    throw new EasyPostError(`Invalid rate value: ${rate}`, 0, 'invalid_rate', null);
  }
  return n;
}

// Pick the cheapest rate from a Shipment, returning a typed reference.
// For v1 we always pick cheapest; future versions can let the bidder
// choose carrier/service explicitly.
export function cheapestRate(rates: Rate[]): Rate | null {
  if (rates.length === 0) return null;
  let best = rates[0]!;
  for (const r of rates) {
    if (Number(r.rate) < Number(best.rate)) best = r;
  }
  return best;
}
