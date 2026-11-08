// PayFeesForm — fires POST /api/bidders/me/pay-fees.
//
// The endpoint (already shipped) creates an off-session PaymentIntent
// against the bidder's default card and calls clear_paid_relot_fees()
// on success. Failure modes:
//   - card_declined / requires_action / requires_payment_method →
//     surface an "Update card" link to /bidder/onboarding/payment-method
//   - no_payment_method / no_stripe_customer → same "Update card" CTA
//   - succeeded → bounce to /profile (the unpaid balance is now zero,
//     so the success state on /profile/pay-fees would just immediately
//     show the empty state).

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { bidderHasZip } from '@/lib/zip-gate-browser';
import { ZipGateModal } from '@/components/bidder/ZipGateModal';

interface PayFeesFormProps {
  hasCard: boolean;
  unpaidCents: number;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const CARD_ISSUE_REASONS = new Set([
  'card_declined',
  'requires_action',
  'requires_payment_method',
  'no_payment_method',
  'no_stripe_customer',
]);

export function PayFeesForm({ hasCard, unpaidCents }: PayFeesFormProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCardUpdate, setNeedsCardUpdate] = useState(!hasCard);
  // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
  // paying fees is a checkout path. null = not checked yet.
  const hasZipRef = useRef<boolean | null>(null);
  const [zipPrompt, setZipPrompt] = useState(false);

  const onPay = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNeedsCardUpdate(false);

    if (hasZipRef.current === null) {
      try {
        const { data: u } = await supabase.auth.getUser();
        hasZipRef.current = u.user ? await bidderHasZip(supabase, u.user.id) : true;
      } catch {
        hasZipRef.current = true; // fail open — never block paying fees on this lookup
      }
    }
    if (!hasZipRef.current) {
      setBusy(false);
      setZipPrompt(true);
      return;
    }

    try {
      const res = await fetch('/api/bidders/me/pay-fees', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        detail?: string;
        error?: string;
        charged_cents?: number;
      };
      if (res.ok && body.ok) {
        // Success — bounce home. The /profile page will show no fees.
        router.push('/profile');
        router.refresh();
        return;
      }
      const reason = body.reason ?? body.error ?? '';
      if (CARD_ISSUE_REASONS.has(reason)) {
        setNeedsCardUpdate(true);
        if (reason === 'card_declined') {
          setError('Your card was declined. Try updating it.');
        } else if (reason === 'requires_action') {
          setError('Your card needs extra verification. Update it and try again.');
        } else if (reason === 'no_payment_method' || reason === 'no_stripe_customer') {
          setError('You don’t have a card on file yet.');
        } else {
          setError(body.detail ?? 'Payment requires updating your card.');
        }
      } else {
        setError(body.detail ?? body.error ?? `Payment failed (${res.status}).`);
      }
    } catch (err) {
      setError((err as Error).message ?? 'Network error.');
    } finally {
      setBusy(false);
    }
  }, [busy, router, supabase]);

  const onZipSaved = useCallback(() => {
    hasZipRef.current = true;
    setZipPrompt(false);
    void onPay();
  }, [onPay]);

  const onZipCancel = useCallback(() => {
    setZipPrompt(false);
  }, []);

  return (
    <div style={{ display: 'grid', gap: '0.85rem' }}>
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

      {needsCardUpdate ? (
        <Link
          href="/bidder/onboarding/payment-method?next=/profile/pay-fees"
          className="btn-primary"
          style={{ padding: '0.95rem', fontSize: '1rem', textAlign: 'center' }}
        >
          Update card
        </Link>
      ) : (
        <button
          type="button"
          onClick={onPay}
          disabled={busy}
          className="btn-primary"
          style={{
            padding: '0.95rem',
            fontSize: '1rem',
            opacity: busy ? 0.7 : 1,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Charging…' : `Pay ${formatMoney(unpaidCents)}`}
        </button>
      )}

      <Link
        href="/profile"
        style={{
          textAlign: 'center',
          color: 'var(--fg-muted)',
          fontSize: 13,
          padding: '0.6rem',
          textDecoration: 'none',
        }}
      >
        Cancel
      </Link>
      {zipPrompt && <ZipGateModal onSaved={onZipSaved} onCancel={onZipCancel} />}
    </div>
  );
}
