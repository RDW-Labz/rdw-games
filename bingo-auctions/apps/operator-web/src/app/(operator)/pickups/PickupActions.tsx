'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { markPickup } from './actions';

export function PickupActions({
  pickupId,
  status,
  invoiceId,
  invoiceStatus,
}: {
  pickupId: string;
  status: string;
  invoiceId: string;
  invoiceStatus: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  if (status === 'completed' || status === 'no_show' || status === 'forfeited') {
    return <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{status}</span>;
  }

  // Money-loss guard (client mirror of the markPickup / staff_confirm_pickup
  // server check): goods only release against a paid invoice. The server
  // rejects regardless, but we also disable the button so staff never click a
  // dead action at the counter. No-show / forfeit stay enabled — those don't
  // release goods (they relist the lots).
  const invoicePaid = invoiceStatus === 'paid' || invoiceStatus === 'partially_refunded';

  async function call(action: 'completed' | 'no_show' | 'forfeited') {
    setBusy(action);
    const result = await markPickup({ pickupId, status: action });
    setBusy(null);
    if (!result.ok) {
      alert(result.error);
      return;
    }
    router.refresh();
  }

  // 0245: fully refunded invoice — nothing is owed, so No-show/Forfeit make
  // no sense (they'd relist goods the customer was refunded for). New
  // refunds auto-complete their pickup; this covers older stranded rows
  // with a single non-destructive close.
  if (invoiceStatus === 'refunded') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem', flexShrink: 0 }}>
        <button onClick={() => call('completed')} disabled={busy !== null} style={buttonStyle}>
          {busy === 'completed' ? '…' : 'Close pickup (refunded)'}
        </button>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Invoice fully refunded — nothing left to hand over
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => call('completed')}
          disabled={busy !== null || !invoicePaid}
          style={{ ...buttonStyle, ...(invoicePaid ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}
          title={invoicePaid ? `Invoice ${invoiceId.slice(0, 8)}` : 'Invoice not paid — Mark paid (offline) first'}
        >
          {busy === 'completed' ? '…' : 'Mark complete'}
        </button>
        <button
          onClick={() => call('no_show')}
          disabled={busy !== null}
          style={secondaryButtonStyle}
        >
          {busy === 'no_show' ? '…' : 'No-show'}
        </button>
        <button
          onClick={() => {
            if (!confirm('Mark this pickup as forfeited? This cannot be undone.')) return;
            call('forfeited');
          }}
          disabled={busy !== null}
          style={forfeitButtonStyle}
          title="Forfeit this pickup — bidder loses the win and lots are relisted"
        >
          {busy === 'forfeited' ? '…' : 'Forfeit'}
        </button>
      </div>
      {!invoicePaid && (
        <a
          href={`/invoices/${invoiceId}`}
          style={{ color: 'var(--danger, #f87171)', fontSize: 12, textDecoration: 'none' }}
        >
          Not paid — Mark paid (offline) first →
        </a>
      )}
    </div>
  );
}

// Styled to visually distinguish the destructive forfeit action from
// the softer secondary "No-show" button — same shape as secondaryButtonStyle
// but uses the danger color token.
const forfeitButtonStyle: React.CSSProperties = {
  padding: '0.35rem 0.75rem',
  borderRadius: 6,
  border: '1px solid var(--danger, #f87171)',
  background: 'transparent',
  color: 'var(--danger, #f87171)',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
