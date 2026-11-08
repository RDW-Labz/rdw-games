'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { secondaryButtonStyle } from '@/components/Form';
import { cancelLot } from './actions';

export function CancelLotButton({ lotId }: { lotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={async () => {
        if (!confirm('Cancel this lot? It will disappear from bidder browse.')) return;
        setBusy(true);
        const result = await cancelLot(lotId);
        setBusy(false);
        if (!result.ok) {
          alert(result.error);
          return;
        }
        router.push('/lots');
        router.refresh();
      }}
      disabled={busy}
      style={{ ...secondaryButtonStyle, color: 'var(--danger)' }}
    >
      {busy ? '…' : 'Cancel lot'}
    </button>
  );
}
