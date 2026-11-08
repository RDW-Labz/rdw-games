'use client';

// Standing "missing items awaiting refund" queue on the pickups dashboard
// (mig 0243). Staff refund on the invoice page (manual, by design), then
// mark the row resolved here.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { resolveMissingItem } from './actions';

export type MissingItemRow = {
  outcomeId: string;
  lotCode: string;
  title: string;
  invoiceId: string;
  bidderLabel: string;
  markedAt: string;
  warehouseId?: string | null;
};

export function MissingItemsQueue({
  rows,
  warehouseQuery,
}: {
  rows: MissingItemRow[];
  warehouseQuery?: string | null;
}) {
  const invoiceQuery = warehouseQuery
    ? `?warehouse=${encodeURIComponent(warehouseQuery)}`
    : '';
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const resolve = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await resolveMissingItem(id);
      if (!res.ok) setError(res.error);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        border: '1px solid rgba(248,113,113,0.4)',
        background: 'rgba(248,113,113,0.06)',
        borderRadius: 8,
        padding: '0.85rem 1rem',
        marginBottom: '1rem',
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>
        Missing items awaiting refund ({rows.length})
      </div>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 6 }}>{error}</div>}
      {rows.map((r) => (
        <div
          key={r.outcomeId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 13,
            padding: '0.35rem 0',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)' }}>
            {r.lotCode}
          </span>
          <span style={{ flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.title} — {r.bidderLabel}
          </span>
          <Link href={`/invoices/${r.invoiceId}${invoiceQuery}`} style={{ color: 'var(--accent)', fontSize: 12 }}>
            Refund on invoice →
          </Link>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy === r.outcomeId}
            onClick={() => resolve(r.outcomeId)}
            style={{ padding: '0.3rem 0.8rem', fontSize: 12, cursor: 'pointer' }}
          >
            {busy === r.outcomeId ? '…' : 'Mark resolved'}
          </button>
        </div>
      ))}
    </div>
  );
}
