// POST /api/bidder/square/save-card
//
// Square replacement for the Stripe setup-intent → payment-method flow. The
// client tokenizes a card with the Square Web Payments SDK (web) or In-App
// Payments SDK (native) and POSTs the resulting token here. We:
//   1. ensure the bidder has a Square customer (square_customer_id)
//   2. vault the card on file (Cards API) → durable card id
//   3. store the card id in bidders.default_payment_method_id + display crumbs
//   4. (0436) if the bidder has no ZIP yet, keep the card's billing ZIP as it.
//      Best effort: never fails or holds up the save (capped, errors swallowed).
// At auction close the auto-charge worker charges that card id off-session.
//
// Body: { source_id: string, verification_token?: string }
//   source_id        — the card nonce/token from the SDK tokenize() call
//   verification_token — optional SCA/3DS buyer-verification token (verifyBuyer)

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  ensureBidderSquareCustomer,
  createCardOnFile,
  listEnabledCustomerCards,
  SquareApiError,
} from '@/lib/square';
import { fillBidderPostalCodeFromCard } from '@/lib/bidder-postal-code-from-card';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }
  // Capture as a plain const: TS drops the non-null narrowing of `caller` inside
  // the nested persistCard() closure below, but a const stays narrowed.
  const { userId } = caller;

  let body: { source_id?: string; verification_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const sourceId = body.source_id;
  if (!sourceId || typeof sourceId !== 'string') {
    return NextResponse.json({ error: 'missing_source_id' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Guard: bidder row must exist (created by /api/bidder/signup). Avoids
  // orphaning a Square customer for a half-provisioned auth user.
  const { data: bidderRow, error: bidderErr } = await admin
    .from('bidders')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (bidderErr) {
    return NextResponse.json({ error: 'bidder_lookup_failed' }, { status: 500 });
  }
  if (!bidderRow) {
    return NextResponse.json({ error: 'not_a_bidder' }, { status: 403 });
  }

  // Ensure the Square customer up front so it's in scope for the recovery path
  // below (a CARD_TOKEN_ALREADY_USED needs to list that customer's cards).
  const customerId = await ensureBidderSquareCustomer(
    admin,
    userId,
    caller.email,
    caller.displayName,
  ).catch((err: unknown) => {
    console.error('[square/save-card] ensure customer failed:', (err as Error).message);
    return null;
  });
  if (!customerId) {
    return NextResponse.json({ error: 'save_card_failed' }, { status: 500 });
  }

  // Store a card id + display crumbs on the bidder. default_payment_method_id
  // holds the Square card id post-cutover (mig 0209); the crumbs let the app show
  // "Visa ••4242" without re-calling Square. This flip unlocks place_bid the same
  // way the Stripe path did (no_payment_method gate keys off it). Returns false
  // on a DB write failure.
  async function persistCard(card: {
    cardId: string;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  }): Promise<boolean> {
    const { error: updErr } = await admin
      .from('bidders')
      .update({
        default_payment_method_id: card.cardId,
        card_brand: card.brand,
        card_last4: card.last4,
        card_exp_month: card.expMonth,
        card_exp_year: card.expYear,
      })
      .eq('id', userId);
    if (updErr) console.error('[square/save-card] card store failed:', updErr.message);
    return !updErr;
  }

  try {
    const card = await createCardOnFile({
      customerId,
      cardToken: sourceId,
      userId: userId,
      verificationToken: body.verification_token,
    });
    if (!(await persistCard(card))) {
      return NextResponse.json({ error: 'card_store_failed' }, { status: 500 });
    }
    // Never rejects; capped at FILL_ZIP_TIMEOUT_MS.
    await fillBidderPostalCodeFromCard(admin, userId, card.billingPostalCode);
    return NextResponse.json({
      ok: true,
      card: {
        brand: card.brand,
        last4: card.last4,
        exp_month: card.expMonth,
        exp_year: card.expYear,
      },
    });
  } catch (err) {
    if (err instanceof SquareApiError) {
      const code = err.errors[0]?.code ?? 'card_error';
      // CARD_TOKEN_ALREADY_USED = the nonce was already consumed into a saved
      // card (e.g. a prior attempt that half-completed, or a fast double-submit).
      // Rather than tell the bidder their good card "declined", re-point them at
      // the card that already exists on their Square customer. Only this exact
      // code triggers recovery — a real decline still surfaces as a decline.
      if (code === 'CARD_TOKEN_ALREADY_USED') {
        try {
          const existing = await listEnabledCustomerCards(customerId);
          const first = existing[0];
          if (first && (await persistCard(first))) {
            return NextResponse.json({
              ok: true,
              reactivated: true,
              card: {
                brand: first.brand,
                last4: first.last4,
                exp_month: first.expMonth,
                exp_year: first.expYear,
              },
            });
          }
        } catch (reErr) {
          console.error(
            '[square/save-card] re-point after CARD_TOKEN_ALREADY_USED failed:',
            (reErr as Error).message,
          );
        }
      }
      // Surface the real Square code to the client so it can show the actual
      // reason (and so a persistent failure is diagnosable, not a generic blob).
      return NextResponse.json({ error: 'card_declined', code }, { status: 402 });
    }
    console.error('[square/save-card] unexpected error:', (err as Error).message);
    return NextResponse.json({ error: 'save_card_failed' }, { status: 500 });
  }
}
