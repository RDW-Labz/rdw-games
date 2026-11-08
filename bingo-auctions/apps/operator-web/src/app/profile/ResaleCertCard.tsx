'use client';

// Reseller tax-exemption card on the bidder profile (mig 0233). Submits the
// permit details to /api/bidder/resale-cert and shows review status.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem 0.8rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'inherit',
};

export function ResaleCertCard({
  status,
  permit,
  state,
  business,
  taxExempt,
}: {
  status: string | null;
  permit: string | null;
  state: string | null;
  business: string | null;
  taxExempt: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(status === null || status === 'rejected');
  const [permitVal, setPermitVal] = useState(permit ?? '');
  const [stateVal, setStateVal] = useState(state ?? 'AR');
  const [businessVal, setBusinessVal] = useState(business ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/bidder/resale-cert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ permit: permitVal, state: stateVal, business_name: businessVal }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Submission failed — try again.');
        setSubmitting(false);
        return;
      }
      setEditing(false);
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600 }}>
            {taxExempt && status === 'approved' ? (
              <span style={{ color: 'var(--accent)' }}>✓ Tax-exempt for resale</span>
            ) : status === 'pending' ? (
              'Certificate under review'
            ) : (
              'Certificate on file'
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
            {business} · permit {permit} ({state}).{' '}
            {status === 'pending'
              ? 'We usually review within one business day — tax stays on until approved.'
              : status === 'approved'
                ? 'Sales tax is not charged on your future invoices.'
                : ''}
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setEditing(true)}
          style={{ padding: '0.55rem 1.1rem', fontSize: 13, cursor: 'pointer' }}
        >
          Update details
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
        Buying for resale? Submit your sales-tax permit and, once approved, your invoices won&apos;t
        include sales tax.{status === 'rejected' && (
          <strong style={{ color: 'var(--danger)' }}> Your last submission was declined — double-check the details and resubmit.</strong>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px', gap: '0.75rem' }}>
        <input
          type="text"
          value={permitVal}
          onChange={(e) => setPermitVal(e.target.value.toUpperCase())}
          placeholder="Sales-tax permit number"
          required
          maxLength={25}
          style={inputStyle}
        />
        <input
          type="text"
          value={stateVal}
          onChange={(e) => setStateVal(e.target.value.toUpperCase())}
          placeholder="AR"
          required
          maxLength={2}
          style={inputStyle}
        />
      </div>
      <input
        type="text"
        value={businessVal}
        onChange={(e) => setBusinessVal(e.target.value)}
        placeholder="Business name on the permit"
        required
        maxLength={120}
        style={inputStyle}
      />
      {error && (
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      )}
      <div>
        <button
          type="submit"
          className="btn-primary"
          disabled={submitting}
          style={{ padding: '0.6rem 1.2rem', fontSize: 14, cursor: submitting ? 'wait' : 'pointer' }}
        >
          {submitting ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
    </form>
  );
}
