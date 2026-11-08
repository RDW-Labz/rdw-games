'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { markShipped } from './actions';

export type ShipRow = {
  id: string;
  totalCents: number;
  shippingCents: number;
  shippingAddress: {
    name?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
  } | null;
  carrier: string | null;
  trackingNumber: string | null;
  labelOnFile: boolean;
  labelPurchasedAt: string | null;
  shippedAt: string | null;
  paidAt: string | null;
  bidderName: string;
  lotCount: number;
  lotTitle: string | null;
};

export function ShippingQueue({ rows, historical }: { rows: ShipRow[]; historical: boolean }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onBuyLabel(invoiceId: string) {
    setBusyId(invoiceId);
    setError(null);
    try {
      const res = await fetch('/api/shipping/buy-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        throw new Error(body.message ?? body.error ?? `Server returned ${res.status}`);
      }
      // Pop the label in a new tab. Operator can print from there.
      window.open(body.labelUrl, '_blank', 'noopener,noreferrer');
      router.refresh();
    } catch (err) {
      setError(`Could not buy label: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  function onMarkShipped(invoiceId: string) {
    if (!confirm('Mark this invoice as shipped? The bidder will be notified that their package is on the way.')) {
      return;
    }
    setBusyId(invoiceId);
    setError(null);
    startTransition(async () => {
      const result = await markShipped(invoiceId);
      setBusyId(null);
      if (!result.ok) {
        setError(`Could not mark shipped: ${result.error}`);
        return;
      }
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: '3rem 2rem',
          textAlign: 'center',
          color: 'var(--fg-muted)',
          background: 'var(--bg-elev)',
          border: '1px dashed var(--border)',
          borderRadius: 8,
        }}
      >
        {historical ? 'No shipped invoices in the recent window.' : 'Nothing to ship right now.'}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div
          style={{
            padding: '0.75rem',
            background: 'rgba(248, 113, 113, 0.1)',
            border: '1px solid var(--danger, #f87171)',
            color: 'var(--danger, #f87171)',
            borderRadius: 6,
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.75rem' }}>
        {rows.map((r) => {
          const stage = r.shippedAt ? 'shipped' : r.labelOnFile ? 'labeled' : 'unlabeled';
          return (
            <li
              key={r.id}
              style={{
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '1rem',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>
                  {r.bidderName} · {r.lotCount} {r.lotCount === 1 ? 'item' : 'items'}
                </div>
                <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 4 }}>
                  {r.lotTitle ? `“${r.lotTitle}” ${r.lotCount > 1 ? `+ ${r.lotCount - 1} more` : ''}` : ''}
                </div>
                {r.shippingAddress && (
                  <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>
                    {r.shippingAddress.name ? `${r.shippingAddress.name} · ` : ''}
                    {r.shippingAddress.street1}
                    {r.shippingAddress.street2 ? `, ${r.shippingAddress.street2}` : ''} ·{' '}
                    {r.shippingAddress.city}, {r.shippingAddress.state} {r.shippingAddress.zip}
                  </div>
                )}
                <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>
                  Paid {r.paidAt ? new Date(r.paidAt).toLocaleString() : 'recently'} ·{' '}
                  Shipping ${(r.shippingCents / 100).toFixed(2)}
                  {r.carrier ? ` · ${r.carrier}` : ''}
                  {r.trackingNumber ? ` · ${r.trackingNumber}` : ''}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {stage === 'unlabeled' && (
                  <button
                    type="button"
                    onClick={() => onBuyLabel(r.id)}
                    disabled={busyId === r.id}
                    style={{
                      ...buttonStyle,
                      opacity: busyId === r.id ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {busyId === r.id ? 'Buying…' : 'Buy label'}
                  </button>
                )}
                {stage === 'labeled' && (
                  <>
                    <a
                      href={`/api/shipping/label/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ ...secondaryButtonStyle, textDecoration: 'none', whiteSpace: 'nowrap' }}
                    >
                      Download label
                    </a>
                    <button
                      type="button"
                      onClick={() => onMarkShipped(r.id)}
                      disabled={busyId === r.id}
                      style={{
                        ...buttonStyle,
                        opacity: busyId === r.id ? 0.6 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Mark shipped
                    </button>
                  </>
                )}
                {stage === 'shipped' && (
                  <a
                    href={`/api/shipping/label/${r.id}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ ...secondaryButtonStyle, textDecoration: 'none', whiteSpace: 'nowrap' }}
                  >
                    Re-download label
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
