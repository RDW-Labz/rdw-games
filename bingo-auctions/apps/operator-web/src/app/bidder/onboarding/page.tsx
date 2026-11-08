// Bidder onboarding gate — bingoauctions.com/bidder/onboarding.
//
// Web equivalent of apps/bidder-app/app/complete-profile.tsx. Required
// after every bidder signup path (email/password, Google, future Apple)
// because Supabase auth only gives us an email; the bidders row needs a
// DOB (18+ gate enforced by migration 0082 trigger + place_bid §A) and
// platform-level consent records before bidding is unlocked.
//
// Page contract:
//   - Reads auth via cookie (server component). No session → /signup.
//   - Reads the bidders row. If birth_date IS NOT NULL AND
//     default_payment_method_id IS NOT NULL → already onboarded, bounce
//     to /browse (or to ?next= if the deep link survived).
//   - If birth_date IS NULL → render the consent form (this page).
//   - If birth_date filled but no card → /bidder/onboarding/payment-method.
//
// The submit form is a client component (OnboardingForm) so DOB picker
// state lives there. The form POSTs to the existing /api/bidder/signup
// route (which already validates 18+ and writes terms_acceptances).

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isPaymentsDisabled } from '@/lib/payments-mode';
import { OnboardingForm } from './OnboardingForm';
import { GuestEscape } from './GuestEscape';
import {
  completedOnboardingHref,
  paymentMethodHref,
  safeInternalPath,
} from '@/lib/bidder-onboarding-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BidderOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  // Validate at the point of use (#825): a crafted onboarding URL must not
  // forward an external destination into any redirect or navigation sink.
  const next = safeInternalPath(rawNext);
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const target = new URL('/signup', 'https://placeholder.local');
    if (next) target.searchParams.set('next', next);
    redirect(target.pathname + target.search);
  }

  const { data: bidder } = await supabase
    .from('bidders')
    .select('id, birth_date, default_payment_method_id')
    .eq('id', user.id)
    .maybeSingle();

  // No live card processor (payments_disabled): a saved card isn't required to
  // bid, so DOB alone fully onboards — skip the payment-method step entirely.
  const paymentsDisabled = await isPaymentsDisabled();

  if (bidder?.birth_date && (bidder?.default_payment_method_id || paymentsDisabled)) {
    // Already fully onboarded (or card not required in test mode).
    redirect(completedOnboardingHref(next));
  }
  if (bidder?.birth_date && !bidder.default_payment_method_id && !paymentsDisabled) {
    // DOB collected, card missing.
    redirect(paymentMethodHref(next));
  }

  return (
    <main style={{ padding: '4rem 1.5rem 5rem', maxWidth: 560, margin: '0 auto' }}>
      {/* Back must not point at a gated page: the public layout would bounce
          a signed-in orphan straight back here. Signing out is the only way
          to reach the anonymous marketplace, so Back is the guest escape. */}
      <GuestEscape
        label="← Back"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '1.5rem',
        }}
      />

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
        {`Step 1 of ${paymentsDisabled ? 1 : 2}`}
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
        One more step
      </h1>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: '1rem',
          lineHeight: 1.65,
          margin: '0 0 2rem',
        }}
      >
        Auctions are age-restricted. We need your date of birth and a quick acknowledgement before
        you can bid.
      </p>

      <OnboardingForm
        defaultDisplayName={
          (user.user_metadata as { display_name?: string; full_name?: string; name?: string })
            .display_name ??
          (user.user_metadata as { display_name?: string; full_name?: string; name?: string })
            .full_name ??
          (user.user_metadata as { display_name?: string; full_name?: string; name?: string })
            .name ??
          user.email?.split('@')[0] ??
          ''
        }
        nextHref={next}
        paymentsDisabled={paymentsDisabled}
      />

      {/* Explicit escape for a visitor who declines consent, cannot meet the
          age gate, or signed in with the wrong account. Signing out returns
          them to anonymous browsing without writing a bidder row or consent. */}
      <p
        style={{
          marginTop: '2rem',
          fontSize: 13,
          color: 'var(--fg-dim)',
          textAlign: 'center',
        }}
      >
        Not ready?{' '}
        <GuestEscape
          label="Continue browsing as a guest"
          style={{ color: 'var(--accent)', textDecoration: 'underline' }}
        />
      </p>
    </main>
  );
}
