'use client';

// Resale-certificate review card on the operator bidder detail page
// (mig 0233). Renders the submitted permit details; admin/manager can
// approve (tax_exempt on) or reject. The server action only acts while the
// submission is still 'pending', so stale clicks are no-ops.

import { useState, useTransition } from 'react';
import { setResaleCertStatus } from '../actions';

export function ResaleCertReview({
  bidderId,
  status,
  permit,
  state,
  business,
  submittedAt,
  canManage,
}: {
  bidderId: string;
  status: string;
  permit: string | null;
  state: string | null;
  business: string | null;
  submittedAt: string | null;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (approve: boolean) =>
    startTransition(async () => {
      setError(null);
      try {
        await setResaleCertStatus(bidderId, approve);
      } catch (err) {
        setError((err as Error).message);
      }
    });

  const tone =
    status === 'approved'
      ? { border: 'rgba(34,197,94,0.4)', label: '✓ Tax-exempt (approved)' }
      : status === 'pending'
        ? { border: 'rgba(240,180,40,0.5)', label: 'Resale certificate — needs review' }
        : { border: 'var(--border)', label: 'Resale certificate — rejected' };

  return (
    <section
      style={{
        padding: '1rem 1.25rem',
        background: 'var(--bg-elev)',
        border: `1px solid ${tone.border}`,
        borderRadius: 10,
        marginBottom: '1rem',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{tone.label}</div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: status === 'pending' && canManage ? 12 : 0 }}>
        {business ?? '—'} · permit <span style={{ fontFamily: 'monospace' }}>{permit ?? '—'}</span> ({state ?? '—'})
        {submittedAt && ` · submitted ${new Date(submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        <br />
        Approving stops sales tax on this bidder&apos;s FUTURE invoices. Verify the permit
        (Arkansas: ATAP lookup) and keep a signed ST-391 on file for audit.
      </div>
      {status === 'pending' && canManage && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => decide(true)}
            style={{ padding: '0.5rem 1.1rem', fontSize: 13, cursor: 'pointer' }}
          >
            Approve — tax exempt
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            onClick={() => decide(false)}
            style={{ padding: '0.5rem 1.1rem', fontSize: 13, cursor: 'pointer' }}
          >
            Reject
          </button>
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</div>}
    </section>
  );
}
