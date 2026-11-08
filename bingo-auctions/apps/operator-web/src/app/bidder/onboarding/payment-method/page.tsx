// Bidder onboarding — card save (Square Web Payments SDK).
//
// Web equivalent of the native card screen. A default card-on-file is required
// before the first bid ONCE payments are live (place_bid §A → no_payment_method);
// while payments_disabled is true, bidding is card-free and this page is optional.
//
// "No-bounce" model: the form is ALWAYS rendered. If the bidder already has a
// card on file we show it (brand + last4 from the bidders row) and offer a
// "continue" link, but the form stays reachable so a bad state can be overwritten.
//
// Server shell:
//   1. Require sign-in + finished step 1 (bidders.birth_date IS NOT NULL) —
//      the one remaining redirect.
//   2. Read the saved-card display crumbs (card_brand/card_last4, mig 0211).
//   3. Render <SquareCardForm> with Square's PUBLIC application + location ids.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { SquareCardForm } from './SquareCardForm';
import { safeInternalPath } from '@/lib/bidder-onboarding-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function formatBrand(brand: string | null): string {
  if (!brand) return 'Card';
  const map: Record<string, string> = {
    VISA: 'Visa',
    MASTERCARD: 'Mastercard',
    AMERICAN_EXPRESS: 'American Express',
    DISCOVER: 'Discover',
    JCB: 'JCB',
    DISCOVER_DINERS: 'Diners',
    CHINA_UNIONPAY: 'UnionPay',
  };
  return map[brand.toUpperCase()] ?? brand;
}

export default async function BidderPaymentMethodPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; force?: string }>;
}) {
  const { next: rawNext, force } = await searchParams;
  const isForced = force === '1';
  // Validate at the point of use (#825): this page feeds both a link href and
  // the card form's post-save navigation.
  const next = safeInternalPath(rawNext);

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/signup');

  const { data: bidder } = await supabase
    .from('bidders')
    .select('id, birth_date, default_payment_method_id, card_brand, card_last4')
    .eq('id', user.id)
    .maybeSingle();

  if (!bidder) redirect('/bidder/onboarding');
  if (!bidder.birth_date) redirect('/bidder/onboarding');

  const hasCard = Boolean(bidder.default_payment_method_id);
  const brand = (bidder.card_brand as string | null) ?? null;
  const last4 = (bidder.card_last4 as string | null) ?? null;

  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!applicationId || !locationId) {
    return (
      <main
        style={{ padding: '4rem 1.5rem', maxWidth: 560, margin: '0 auto', textAlign: 'center' }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 900, marginBottom: '0.75rem' }}>
          Payments unavailable
        </h1>
        <p style={{ color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          Card payments aren&apos;t configured yet. Please contact{' '}
          <a href="mailto:support@bingoauctions.com" style={{ color: 'var(--accent)' }}>
            support@bingoauctions.com
          </a>
          .
        </p>
      </main>
    );
  }

  const stepLabel = hasCard ? 'Update card' : 'Step 2 of 2';
  const headline = hasCard ? 'Update payment method' : 'Save a payment method';

  return (
    <main style={{ padding: '4rem 1.5rem 5rem', maxWidth: 560, margin: '0 auto' }}>
      <Link
        href="/bidder/onboarding"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '1.5rem',
        }}
      >
        &larr; Back
      </Link>

      <div
        style={{
          fontSize: 11,
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: 2,
          fontWeight: 800,
          marginBottom: '0.75rem',
        }}
      >
        {stepLabel}
      </div>
      <h1
        style={{
          fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
          fontWeight: 900,
          letterSpacing: -1,
          lineHeight: 1.15,
          margin: '0 0 0.5rem',
        }}
      >
        {headline}
      </h1>
      <p
        style={{ color: 'var(--fg-muted)', fontSize: '1rem', lineHeight: 1.65, margin: '0 0 2rem' }}
      >
        We&apos;ll charge this card automatically if you win an auction. You won&apos;t be charged
        today — this is just a card-on-file authorization.
      </p>

      {!isForced && hasCard && (
        <div
          style={{
            padding: '0.85rem 1rem',
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent)',
            color: 'var(--accent)',
            borderRadius: 6,
            marginBottom: '1.5rem',
            fontSize: 14,
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Card on file: {formatBrand(brand)} &middot;&middot;&middot;&middot; {last4 ?? '----'}
          </div>
          <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            You&apos;re all set. Save a different card below to replace it, or{' '}
            <Link
              href={next ?? '/browse'}
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}
            >
              continue to {next ?? '/browse'}
            </Link>
            .
          </div>
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 2,
          fontWeight: 800,
          marginBottom: '0.75rem',
        }}
      >
        {hasCard ? 'Add another card' : 'Add a card'}
      </div>

      <SquareCardForm
        applicationId={applicationId}
        locationId={locationId}
        nextHref={next}
        hasExistingCard={hasCard}
      />
    </main>
  );
}
