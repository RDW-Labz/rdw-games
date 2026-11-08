// Quote a shipping rate for an invoice. Called by the bidder app during
// checkout when they pick "Ship to me".
//
// Flow:
//   1. Auth the bidder via Bearer token (mobile) or cookie session (web).
//   2. Fetch the invoice + operator. Verify caller is the invoice's bidder.
//   3. Verify the operator offers shipping and has a return address configured.
//   4. Call EasyPost to quote rates from operator's return → bidder's address.
//   5. Pick the cheapest rate (v1 policy). Add handling fee.
//   6. Return { shipmentId, rateId, totalCents, carrier, service, eta }.
//
// The bidder then calls set_invoice_fulfillment RPC with these values to
// commit the choice before payment collection.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { cheapestRate, quoteRates, rateDollarsToCents, type Address } from '@/lib/easypost';

export const runtime = 'nodejs';

const addressSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  street1: z.string().min(1).max(120),
  street2: z.string().max(120).optional(),
  city: z.string().min(1).max(80),
  state: z.string().length(2),
  zip: z.string().min(5).max(10),
  country: z.string().length(2).optional(),
  phone: z.string().min(7).max(20).optional(),
});

const bodySchema = z.object({
  invoiceId: z.string().uuid(),
  toAddress: addressSchema,
});

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  let parsed;
  try {
    const json = await req.json();
    parsed = bodySchema.safeParse(json);
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();

  // Look up the invoice with operator info attached. Use admin client
  // because the bidder may not have full SELECT on every operator field.
  const { data: invoiceRow } = await admin
    .from('invoices')
    .select('id, bidder_id, operator_id, status')
    .eq('id', parsed.data.invoiceId)
    .single();

  if (!invoiceRow) {
    return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  }
  if ((invoiceRow as { bidder_id: string }).bidder_id !== caller.userId) {
    return NextResponse.json({ error: 'not_invoice_bidder' }, { status: 403 });
  }
  if ((invoiceRow as { status: string }).status !== 'pending') {
    return NextResponse.json({ error: 'invoice_not_pending' }, { status: 409 });
  }

  const { data: opRow } = await admin
    .from('operators')
    .select('id, offers_shipping')
    .eq('id', (invoiceRow as { operator_id: string }).operator_id)
    .single();
  if (!opRow || !(opRow as { offers_shipping: boolean | null }).offers_shipping) {
    return NextResponse.json({ error: 'shipping_not_offered' }, { status: 422 });
  }

  const { data: cfgRow } = await admin
    .from('operator_shipping_config')
    .select(
      'return_address, default_pkg_weight_oz, default_pkg_length_in, default_pkg_width_in, default_pkg_height_in, handling_fee_cents',
    )
    .eq('operator_id', (invoiceRow as { operator_id: string }).operator_id)
    .maybeSingle();

  if (!cfgRow) {
    return NextResponse.json(
      { error: 'shipping_not_configured', message: 'Operator enabled shipping but hasn\'t set a return address.' },
      { status: 422 },
    );
  }
  const cfg = cfgRow as {
    return_address: Address;
    default_pkg_weight_oz: number;
    default_pkg_length_in: number;
    default_pkg_width_in: number;
    default_pkg_height_in: number;
    handling_fee_cents: number;
  };

  // Call EasyPost. Surface a stable error code if the key isn't set or
  // the address is undeliverable so the bidder app can show a helpful
  // message instead of an opaque 500.
  try {
    const shipment = await quoteRates({
      from: cfg.return_address,
      to: parsed.data.toAddress as Address,
      parcel: {
        length: Number(cfg.default_pkg_length_in),
        width: Number(cfg.default_pkg_width_in),
        height: Number(cfg.default_pkg_height_in),
        weight: cfg.default_pkg_weight_oz,
      },
    });

    const best = cheapestRate(shipment.rates);
    if (!best) {
      return NextResponse.json(
        { error: 'no_rates_available', message: 'No carrier can deliver to this address.' },
        { status: 422 },
      );
    }

    const carrierCents = rateDollarsToCents(best.rate);
    const totalCents = carrierCents + (cfg.handling_fee_cents ?? 0);

    return NextResponse.json({
      shipmentId: shipment.id,
      rateId: best.id,
      carrier: best.carrier,
      service: best.service,
      carrierCents,
      handlingCents: cfg.handling_fee_cents ?? 0,
      totalCents,
      etaDays: best.delivery_days ?? best.est_delivery_days ?? null,
      etaDate: best.delivery_date ?? null,
    });
  } catch (err) {
    const message = (err as Error).message ?? 'EasyPost error';
    const code =
      (err as { code?: string | null }).code === 'config_missing'
        ? 'config_missing'
        : (err as { code?: string | null }).code === 'address_undeliverable'
          ? 'address_undeliverable'
          : 'shipping_quote_failed';
    return NextResponse.json({ error: code, message }, { status: code === 'config_missing' ? 500 : 422 });
  }
}
