// RetryGraceButton — S11 (2026-06-01).
//
// Client component rendered inside the payment_failed_grace recovery block
// on /profile/invoices/[id]. POSTs to the EXISTING safe route:
//   POST /api/invoices/[id]/retry-auto-charge
// That route only INSERTs/UPSERTs a row into auto_charge_jobs so the
// auto-charge worker picks it up on the next pass (~1 min). It does NOT
// charge a card itself — the cron does that. No new money
// path is introduced here.

'use client';

import { useState } from 'react';

interface RetryGraceButtonProps {
  invoiceId: string;
}

export function RetryGraceButton({ invoiceId }: RetryGraceButtonProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRetry() {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/invoices/${encodeURIComponent(invoiceId)}/retry-auto-charge`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: string;
      };
      if (res.ok && body.ok) {
        setDone(true);
        return;
      }
      if (body.error === 'not_in_grace') {
        setError('This invoice is no longer in the grace window.');
      } else {
        setError(body.error ?? `Request failed (${res.status}).`);
      }
    } catch (err) {
      setError((err as Error).message ?? 'Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        style={{
          padding: '0.75rem 1.25rem',
          background: 'var(--success-dim, rgba(34, 197, 94, 0.12))',
          border: '1px solid var(--success, #22c55e)',
          color: 'var(--success, #22c55e)',
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        &#10004; Queued — we&apos;ll retry your card within a minute.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      {error && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--danger)',
            background: 'rgba(255, 59, 59, 0.08)',
            border: '1px solid rgba(255, 59, 59, 0.4)',
            padding: '0.5rem 0.75rem',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="btn-secondary"
        style={{
          padding: '0.75rem 1.25rem',
          fontSize: '0.9rem',
          opacity: busy ? 0.7 : 1,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Queueing…' : 'Retry payment'}
      </button>
    </div>
  );
}
