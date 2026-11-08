'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';

const METHODS = [
  { value: '', label: '— How was it paid? (optional) —' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'card_terminal', label: 'Card (terminal / Square reader)' },
  { value: 'other', label: 'Other' },
] as const;

// Operator action: mark an unpaid invoice paid OFFLINE (cash/check collected in
// person, or payments-disabled mode). Posts to /api/invoices/[id]/mark-paid, which
// enforces operator scope + AAL2 + an auction-settled guard. Mirrors RefundButton.
//
// method/reason are optional (the route accepts a bare POST too) but every
// mark-paid now lands in operator_audit_log with whatever the staffer gave —
// so a quick note here is the difference between "who/why" being recorded or
// not (4 prod invoices had no actor trace before this).
export function MarkPaidButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('');
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={secondaryButtonStyle}>
        Mark paid (offline)
      </button>
    );
  }

  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <h3 style={{ marginTop: 0 }}>Mark paid offline</h3>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        Records this invoice as paid WITHOUT a card charge — for cash/check
        collected in person, or while testing without a live processor. No money
        moves. This unblocks checkout &amp; pickup for the lot.
      </p>
      <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>How was it paid?</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
            style={inputStyle}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Note (optional)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. paid at counter, John R."
            maxLength={500}
            style={inputStyle}
          />
        </label>
      </div>
      {error && <div style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={async () => {
            setError(null);
            setLoading(true);
            const res = await fetch(`/api/invoices/${invoiceId}/mark-paid`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...(method ? { method } : {}),
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              }),
            });
            setLoading(false);
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              setError(err.error ?? `Server returned ${res.status}`);
              return;
            }
            setOpen(false);
            router.refresh();
          }}
          disabled={loading}
          style={buttonStyle}
        >
          {loading ? 'Marking…' : 'Confirm paid'}
        </button>
        <button onClick={() => setOpen(false)} style={secondaryButtonStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}
