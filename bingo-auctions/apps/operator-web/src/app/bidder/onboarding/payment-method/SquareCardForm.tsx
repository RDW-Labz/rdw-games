// SquareCardForm — Square Web Payments SDK card entry + card-on-file vault.
//
// Lifecycle:
//   1. Load https://web.squarecdn.com/v1/square.js (once).
//   2. window.Square.payments(applicationId, locationId) → card element.
//   3. Submit → card.tokenize() → token. Optionally payments.verifyBuyer()
//      with intent 'STORE' for SCA (US cards rarely challenge; best-effort).
//   4. POST { source_id, verification_token } → /api/bidder/square/save-card,
//      which vaults the card on file and stores the card id on the bidder.
//   5. On success bounce to nextHref (default /browse).
//
// applicationId + locationId are Square's PUBLIC identifiers (like a Stripe
// publishable key) — safe to expose client-side. The secret access token never
// leaves the server.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { captureCardSaved } from '@/lib/posthog-events';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { bidderHasZip } from '@/lib/zip-gate-browser';
import { ZipGateModal } from '@/components/bidder/ZipGateModal';
import { completedOnboardingHref } from '@/lib/bidder-onboarding-gate';

interface SquareCardFormProps {
  applicationId: string;
  locationId: string;
  nextHref: string | null;
  /** True when the bidder already had a card on file (drives the is_first
   *  analytics flag on save). */
  hasExistingCard?: boolean;
}

// Minimal shape of the bits of the Web Payments SDK we touch.
type SquareCard = {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
};
type SquarePayments = {
  card: () => Promise<SquareCard>;
  verifyBuyer: (
    token: string,
    details: { intent: 'STORE'; billingContact?: Record<string, string> },
  ) => Promise<{ token?: string } | undefined>;
};
declare global {
  interface Window {
    Square?: { payments: (appId: string, locationId: string) => SquarePayments };
  }
}

const SDK_SRC = 'https://web.squarecdn.com/v1/square.js';

// Map a Square save-card failure to a human message. `code` is the Square API
// error code the server forwards (err.errors[0].code) — a code-specific message
// tells the bidder what to actually fix instead of a generic "declined".
function saveCardMessage(error?: string, code?: string): string {
  switch (code) {
    case 'CVV_FAILURE':
    case 'VERIFY_CVV_FAILURE':
      return 'The security code (CVV) didn’t match. Re-enter your card details.';
    case 'ADDRESS_VERIFICATION_FAILURE':
    case 'VERIFY_AVS_FAILURE':
      return 'The billing ZIP didn’t match your card. Check it and try again.';
    case 'INVALID_EXPIRATION':
    case 'INVALID_EXPIRATION_DATE':
    case 'CARD_EXPIRED':
      return 'That card is expired or the expiry date is wrong. Check it and try again.';
    case 'INVALID_CARD':
    case 'INVALID_CARD_DATA':
      return 'Those card details look invalid. Double-check the number and try again.';
    case 'INSUFFICIENT_FUNDS':
      return 'Your card was declined for insufficient funds. Try a different card.';
    case 'CARD_DECLINED':
    case 'GENERIC_DECLINE':
    case 'CARD_DECLINED_VERIFICATION_REQUIRED':
      return 'Your card was declined. Try a different card.';
    default:
      if (error === 'card_declined') {
        return code
          ? `Your card couldn’t be saved (${code.toLowerCase().replace(/_/g, ' ')}). Try a different card.`
          : 'Your card was declined. Try a different card.';
      }
      return 'We couldn’t save that card. Please try again.';
  }
}

function loadSquareSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.Square) return resolve();
    const existing = document.querySelector(`script[src="${SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('sdk load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('sdk load failed'));
    document.head.appendChild(s);
  });
}

export function SquareCardForm({
  applicationId,
  locationId,
  nextHref,
  hasExistingCard = false,
}: SquareCardFormProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const cardRef = useRef<SquareCard | null>(null);
  const paymentsRef = useRef<SquarePayments | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
  // adding a card on file is a checkout path. null = not checked yet.
  const hasZipRef = useRef<boolean | null>(null);
  const [zipPrompt, setZipPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSquareSdk();
        if (cancelled || !window.Square) return;
        const payments = window.Square.payments(applicationId, locationId);
        paymentsRef.current = payments;
        const card = await payments.card();
        if (cancelled) return;
        await card.attach('#sq-card-container');
        cardRef.current = card;
        setReady(true);
      } catch (err) {
        if (!cancelled) setError('Could not load the secure card form. Refresh and try again.');
        console.error('[SquareCardForm] init failed:', (err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId, locationId]);

  const onSubmit = useCallback(async () => {
    if (!cardRef.current || submitting) return;
    setSubmitting(true);
    setError(null);

    // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
    // checked before tokenizing the card so a bidder who needs it sees the
    // ZIP step first, not a saved card followed by a surprise prompt.
    if (hasZipRef.current === null) {
      try {
        const { data: u } = await supabase.auth.getUser();
        hasZipRef.current = u.user ? await bidderHasZip(supabase, u.user.id) : true;
      } catch {
        hasZipRef.current = true; // fail open — never block adding a card on this lookup
      }
    }
    if (!hasZipRef.current) {
      setSubmitting(false);
      setZipPrompt(true);
      return;
    }

    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== 'OK' || !result.token) {
        setError(result.errors?.[0]?.message ?? 'Please check your card details and try again.');
        setSubmitting(false);
        return;
      }
      const token = result.token;

      // Best-effort SCA verification for storing the card (intent STORE). US
      // cards rarely challenge; if verifyBuyer throws we proceed with the raw
      // token (save-card will still succeed for non-SCA cards).
      let verificationToken: string | undefined;
      try {
        const verification = await paymentsRef.current?.verifyBuyer(token, { intent: 'STORE' });
        verificationToken = verification?.token;
      } catch {
        /* proceed without — non-SCA path */
      }

      const res = await fetch('/api/bidder/square/save-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: token, verification_token: verificationToken }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      if (!res.ok || !json.ok) {
        setError(saveCardMessage(json.error, json.code));
        setSubmitting(false);
        return;
      }
      captureCardSaved({ is_first: !hasExistingCard });
      setDone(true);
      router.push(completedOnboardingHref(nextHref));
    } catch (err) {
      console.error('[SquareCardForm] submit failed:', (err as Error).message);
      setError('Something went wrong saving your card. Please try again.');
      setSubmitting(false);
    }
  }, [submitting, nextHref, router, hasExistingCard, supabase]);

  const onZipSaved = useCallback(() => {
    hasZipRef.current = true;
    setZipPrompt(false);
    void onSubmit();
  }, [onSubmit]);

  const onZipCancel = useCallback(() => {
    setZipPrompt(false);
  }, []);

  return (
    <div>
      <div
        id="sq-card-container"
        style={{
          minHeight: 90,
          padding: '0.5rem 0',
          marginBottom: '1rem',
        }}
      />
      {error && (
        <div
          style={{ color: 'var(--danger)', fontSize: 14, marginBottom: '1rem', lineHeight: 1.5 }}
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!ready || submitting || done}
        style={{
          width: '100%',
          padding: '0.9rem 1rem',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          fontWeight: 800,
          fontSize: 15,
          cursor: !ready || submitting ? 'default' : 'pointer',
          opacity: !ready || submitting || done ? 0.6 : 1,
        }}
      >
        {done ? 'Saved ✓' : submitting ? 'Saving…' : ready ? 'Save card' : 'Loading…'}
      </button>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: '0.75rem', lineHeight: 1.5 }}>
        Secured by Square. We store a card on file and only charge it if you win.
      </p>
      {zipPrompt && <ZipGateModal onSaved={onZipSaved} onCancel={onZipCancel} />}
    </div>
  );
}
