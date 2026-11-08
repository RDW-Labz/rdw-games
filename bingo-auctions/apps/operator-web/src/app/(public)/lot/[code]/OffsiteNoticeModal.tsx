// Off-site warehouse notice gate for web bids.
//
// Shown when the lot's warehouse has customer_notice and the bidder has not
// yet acknowledged it. Parent owns the bid; this records ack_warehouse_notice
// then reports accept / cancel.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import type { WarehousePickupDescribed } from '@/lib/warehouse-pickup';

export function OffsiteNoticeModal({
  pickup,
  warehouseId,
  onAccepted,
  onCancel,
}: {
  pickup: WarehousePickupDescribed;
  warehouseId: string;
  onAccepted: () => void;
  onCancel: () => void;
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !submitting) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  async function accept() {
    setError(null);
    setSubmitting(true);
    const { error: rpcErr } = await supabase.rpc('ack_warehouse_notice', {
      p_warehouse_id: warehouseId,
    });
    setSubmitting(false);
    if (rpcErr) {
      console.warn('[OffsiteNoticeModal] ack_warehouse_notice failed; proceeding with bid', rpcErr);
      onAccepted();
      return;
    }
    onAccepted();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="offsite-notice-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.65)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 640,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem 0.75rem' }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
            }}
          >
            {pickup.name ?? 'Pickup location'}
          </div>
          <div id="offsite-notice-title" style={{ fontSize: '1.25rem', fontWeight: 900, marginTop: 4 }}>
            Off-site pickup notice
          </div>
        </div>

        <div
          style={{
            overflowY: 'auto',
            padding: '0.25rem 1.5rem 0.75rem',
            fontSize: 14,
            lineHeight: 1.6,
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
            flex: 1,
            minHeight: 120,
            display: 'grid',
            gap: '0.75rem',
          }}
        >
          {pickup.notice && (
            <p style={{ fontWeight: 800, margin: 0 }}>{pickup.notice}</p>
          )}
          {pickup.addressLines.length > 0 && (
            <div>
              {pickup.addressLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
          {pickup.hoursLines.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Pickup hours</div>
              {pickup.hoursLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
          {pickup.instructions && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Instructions</div>
              <p style={{ margin: 0 }}>{pickup.instructions}</p>
            </div>
          )}
          {pickup.directionsUrl && (
            <a
              href={pickup.directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 700 }}
            >
              Get directions
            </a>
          )}
        </div>

        <div style={{ padding: '0.9rem 1.5rem 1.25rem', display: 'grid', gap: '0.75rem' }}>
          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 700 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="btn-secondary"
              style={{ flex: 1, padding: '0.85rem', opacity: submitting ? 0.5 : 1 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={accept}
              disabled={submitting}
              className="btn-primary"
              style={{
                flex: 1,
                padding: '0.85rem',
                opacity: submitting ? 0.5 : 1,
                cursor: submitting ? 'wait' : 'pointer',
              }}
            >
              {submitting ? 'Saving…' : 'I understand — continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
