'use client';

// "Redistribute close times" button. Recomputes lots.close_at evenly
// across [ends_at, last_lot_ends_at] for the current auction. Renders
// after lots are visible on the detail page; greys out when the
// auction has no last_lot_ends_at set (legacy fixed-stagger mode) or
// is locked (live/closed/canceled).

import { useState, useTransition } from 'react';
import { redistributeCloseTimes } from './redistribute-actions';
import { useRouter } from 'next/navigation';

export function RedistributeButton({
  auctionId,
  hasWindow,
  canEdit,
  lotCount,
}: {
  auctionId: string;
  /** true when auctions.last_lot_ends_at is set (the new two-endpoint mode). */
  hasWindow: boolean;
  /** false when the auction is live/closed/canceled. */
  canEdit: boolean;
  lotCount: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const disabled = !hasWindow || !canEdit || pending || lotCount < 2;

  function onClick() {
    setMsg(null);
    start(async () => {
      const r = await redistributeCloseTimes({ auctionId });
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      setMsg(`Redistributed close times for ${r.updated} lot${r.updated === 1 ? '' : 's'}.`);
      router.refresh();
    });
  }

  const tooltip = !hasWindow
    ? 'Set "Last lot closes at" on the auction edit page first.'
    : !canEdit
      ? 'Cannot redistribute on a live or closed auction.'
      : lotCount < 2
        ? 'Need at least 2 lots to redistribute.'
        : 'Spread lot close times evenly across the window.';

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
        style={{
          padding: '6px 12px',
          background: disabled ? 'transparent' : 'var(--accent-dim)',
          color: disabled ? 'var(--fg-muted)' : 'var(--accent)',
          border: '1px solid',
          borderColor: disabled ? 'var(--border)' : 'var(--accent)',
          borderRadius: 4,
          cursor: disabled ? 'not-allowed' : pending ? 'wait' : 'pointer',
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {pending ? 'Redistributing…' : 'Redistribute close times'}
      </button>
      {msg && (
        <span
          style={{
            color: msg.startsWith('Redistributed') ? 'var(--accent)' : 'var(--danger)',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {msg}
        </span>
      )}
    </span>
  );
}
