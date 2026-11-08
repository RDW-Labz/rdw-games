'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteLot } from './actions';

// Hard-delete a single lot from the lot detail page. The button is
// hidden unless the lot is in a delete-safe status AND has no bids — the
// server action re-checks both, so a stale page can't slip through. A lot
// with a sticker, a shelf or location history is refused (mig 0400); the
// error shown below the button tells staff to use Remove from inventory.
//
// We chose a separate delete-from-detail-page UX (no bulk delete
// elsewhere) deliberately: deletes happen one at a time so accidents
// are bounded to one row.
export function DeleteLotButton({
  lotId,
  lotCode,
}: {
  lotId: string;
  lotCode: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    const confirmed = window.confirm(
      `Permanently delete ${lotCode}? This can't be undone.`,
    );
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const r = await deleteLot({ lot_id: lotId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push('/lotting/inventory');
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        style={{
          padding: '6px 12px',
          background: 'transparent',
          color: 'var(--danger)',
          border: '1px solid var(--danger)',
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 700,
          cursor: pending ? 'not-allowed' : 'pointer',
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {error && (
        <span
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            fontWeight: 600,
            marginLeft: 8,
          }}
        >
          {error}
        </span>
      )}
    </>
  );
}
