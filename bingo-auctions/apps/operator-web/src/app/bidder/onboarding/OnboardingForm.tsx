// Bidder onboarding form — client component for the DOB + consent step.
//
// Submits to the existing POST /api/bidder/signup endpoint, which:
//   1. Validates birth_date AND age >= 18 (mirrors the DB trigger)
//   2. Inserts the bidders row (display_name + birth_date)
//   3. Records terms_acceptances rows for each accepted policy
//
// The endpoint accepts cookie OR Bearer auth via verifyAuth(); a same-origin
// fetch from the browser carries the Supabase session cookie automatically.
// On success we navigate to /bidder/onboarding/payment-method to collect
// the card (place_bid rejects with 'no_payment_method' otherwise).

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { captureBidderOnboarded } from '@/lib/posthog-events';
import { postOnboardingHref } from '@/lib/bidder-onboarding-gate';

interface OnboardingFormProps {
  defaultDisplayName: string;
  /** Deep-link target carried through onboarding (e.g. a /lot/[code] page
   * the bidder was trying to bid on). Forwarded to the payment-method
   * step, which forwards to /browse → /lot deep link. Null when none. */
  nextHref: string | null;
  /** When true (platform has no live card processor — payments_disabled), the
   *  payment-method step is skipped: DOB + consent alone completes onboarding. */
  paymentsDisabled?: boolean;
}

/** Calculate age in whole years (UTC) — mirrors the mobile signup logic. */
function calcAge(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** Today's date in YYYY-MM-DD for the date input's max attribute. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function OnboardingForm({
  defaultDisplayName,
  nextHref,
  paymentsDisabled = false,
}: OnboardingFormProps) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [birthDate, setBirthDate] = useState<string>(''); // YYYY-MM-DD
  const [referralCode, setReferralCode] = useState('');
  const [phone, setPhone] = useState('');

  // "Give $5, get $5" (mig 0229): share links land on /signup?ref=CODE, but
  // email confirmation loses the query param before this step. The signup
  // page stashes it in localStorage; pick it up here (URL ?ref= wins when
  // both are present, e.g. a direct deep-link to onboarding).
  useEffect(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('ref');
      const stashed = window.localStorage.getItem('bingo_ref');
      const code = (fromUrl ?? stashed ?? '').trim().toUpperCase();
      if (code) setReferralCode(code);
    } catch {
      // localStorage unavailable (private mode) — field stays manual.
    }
  }, []);
  const [ageAck, setAgeAck] = useState(false);
  const [tosAck, setTosAck] = useState(false);
  const [bidderAck, setBidderAck] = useState(false);
  const [autoChargeAck, setAutoChargeAck] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ageOk = useMemo(() => {
    if (!birthDate) return false;
    // Parse as UTC midnight to match the iOS app's toISODate behavior.
    const d = new Date(birthDate + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    return calcAge(d) >= 18;
  }, [birthDate]);

  const canSubmit =
    !submitting &&
    displayName.trim().length > 0 &&
    !!birthDate &&
    ageOk &&
    ageAck &&
    tosAck &&
    bidderAck &&
    autoChargeAck;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!birthDate) {
      setError('Please enter your date of birth.');
      return;
    }
    const d = new Date(birthDate + 'T00:00:00Z');
    if (isNaN(d.getTime()) || calcAge(d) < 18) {
      setError('You must be at least 18 years old to create a bidder account.');
      return;
    }
    if (!ageAck || !tosAck || !bidderAck || !autoChargeAck) {
      setError('Please check all required boxes before continuing.');
      return;
    }

    setSubmitting(true);

    try {
      // The /api/bidder/signup endpoint:
      //   - reads the session cookie via verifyAuth
      //   - writes the bidders row + terms_acceptances rows
      //   - returns { ok: true } or { ok: false, error }
      //
      // Display name flows separately via user_metadata.display_name on
      // signup — but for OAuth signups the metadata might not have it,
      // so we PATCH it explicitly here before the signup call. This
      // mirrors the iOS signup which passes data:{display_name} to
      // auth.signUp; the OAuth/complete-profile path doesn't, so we
      // back-fill via auth.updateUser.
      const { getSupabaseBrowser } = await import('@/lib/supabase-browser');
      const supabase = getSupabaseBrowser();
      const trimmedName = displayName.trim();
      if (trimmedName) {
        await supabase.auth.updateUser({ data: { display_name: trimmedName } });
      }

      const res = await fetch('/api/bidder/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          birth_date: birthDate,
          consent_slugs: ['terms', 'privacy', 'bidder-agreement'],
          consent_method: 'web_signup_checkbox',
          ...(referralCode.trim() ? { referral_code: referralCode.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Onboarding failed. Please try again.');
        setSubmitting(false);
        return;
      }

      // Funnel: step 1 (DOB + consents) complete. The card-save step
      // captures its own event in CardSetupForm.
      captureBidderOnboarded();

      // Validate `next` at this second boundary too (#825): a direct URL can
      // reach the form without the server having normalised it, and a crafted
      // value must never become an external navigation target.
      router.push(postOnboardingHref(nextHref, paymentsDisabled));
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? 'Network error — please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem' }}>
      <Field label="Display name">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={80}
          autoComplete="name"
          style={inputStyle}
        />
      </Field>

      <Field label="Date of birth">
        <input
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          required
          max={todayIso()}
          style={inputStyle}
        />
        {birthDate && !ageOk && (
          <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
            You must be at least 18 years old to create a bidder account.
          </div>
        )}
      </Field>

      <Field label="Phone (optional)">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={20}
          placeholder="Earn loyalty points + get pickup texts"
          autoComplete="tel"
          style={inputStyle}
        />
      </Field>

      <Field label="Referral code (optional)">
        <input
          type="text"
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
          maxLength={12}
          placeholder="Have a friend's code? Get $5 off your first win."
          autoComplete="off"
          style={inputStyle}
        />
      </Field>

      {/* Consent checkboxes — order matches the mobile signup. */}
      <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.75rem' }}>
        <Consent checked={ageAck} onChange={setAgeAck} label="I am at least 18 years old." />
        <Consent
          checked={tosAck}
          onChange={setTosAck}
          label={
            <>
              I agree to the{' '}
              <Link href="/legal/terms" target="_blank" style={legalLink}>
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/legal/privacy" target="_blank" style={legalLink}>
                Privacy Policy
              </Link>
              .
            </>
          }
        />
        <Consent
          checked={bidderAck}
          onChange={setBidderAck}
          label={
            <>
              I agree to the{' '}
              <Link href="/legal/bidder-agreement" target="_blank" style={legalLink}>
                Bidder Agreement
              </Link>
              .
            </>
          }
        />
        <Consent
          checked={autoChargeAck}
          onChange={setAutoChargeAck}
          label="I authorize BinGo Auctions to save my payment method and charge it automatically when I win an auction."
        />
      </div>

      {error && (
        <div
          style={{
            color: 'var(--danger)',
            fontSize: 14,
            background: 'rgba(255, 59, 59, 0.08)',
            border: '1px solid rgba(255, 59, 59, 0.4)',
            padding: '0.75rem 1rem',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="btn-primary"
        style={{
          padding: '0.95rem',
          fontSize: '1rem',
          marginTop: '0.5rem',
          opacity: canSubmit ? 1 : 0.55,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {submitting
          ? 'Saving…'
          : paymentsDisabled
            ? 'Finish & start bidding'
            : 'Continue to payment method'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

function Consent({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        fontSize: 14,
        lineHeight: 1.5,
        color: 'var(--fg)',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flexShrink: 0, accentColor: 'var(--accent)' }}
      />
      <span>{label}</span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '0.7rem 0.85rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  fontSize: 15,
  fontFamily: 'inherit',
  // Date input quirk: Chrome's default color is dark gray on dark bg.
  colorScheme: 'dark',
};

const legalLink: React.CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
};
