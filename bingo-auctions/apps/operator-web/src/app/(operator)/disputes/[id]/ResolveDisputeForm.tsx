'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents, formatCents } from '@auction-platform/shared';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { resolveDispute } from './actions';

export function ResolveDisputeForm({
  disputeId,
  invoiceId,
  maxRefundCents,
}: {
  disputeId: string;
  invoiceId: string;
  maxRefundCents: number;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<'resolved' | 'denied'>('resolved');
  const [refundDollars, setRefundDollars] = useState((maxRefundCents / 100).toFixed(2));
  const [issueRefund, setIssueRefund] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let refundCents = 0;
    if (decision === 'resolved' && issueRefund) {
      try {
        refundCents = dollarsToCents(refundDollars);
      } catch {
        setError('Invalid refund amount');
        return;
      }
      if (refundCents <= 0 || refundCents > maxRefundCents) {
        setError(`Refund must be between $0.01 and ${formatCents(maxRefundCents)}.`);
        return;
      }
    }
    setBusy(true);
    const result = await resolveDispute({
      disputeId,
      invoiceId,
      decision,
      refundCents,
      issueStripeRefund: issueRefund && refundCents > 0,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'grid',
        gap: '0.75rem',
        maxWidth: 540,
      }}
    >
      <Field label="Decision">
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value as typeof decision)}
          style={inputStyle}
        >
          <option value="resolved">Resolve (in bidder&apos;s favor)</option>
          <option value="denied">Deny</option>
        </select>
      </Field>

      {decision === 'resolved' && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={issueRefund}
              onChange={(e) => setIssueRefund(e.target.checked)}
            />
            Issue card refund (Square)
          </label>
          {issueRefund && (
            <Field
              label="Refund amount ($)"
              hint={`Max ${formatCents(maxRefundCents)}. Platform fee refunds proportionally.`}
            >
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="0.01"
                value={refundDollars}
                onChange={(e) => setRefundDollars(e.target.value)}
              />
            </Field>
          )}
        </>
      )}

      <Field label="Notes (sent to bidder)">
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={submit} disabled={busy} style={buttonStyle}>
          {busy ? 'Submitting…' : decision === 'resolved' ? 'Resolve' : 'Deny'}
        </button>
        <button onClick={() => router.back()} style={secondaryButtonStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}
