'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { secondaryButtonStyle } from '@/components/Form';
import { cancelAuction } from '../new/actions';

export function CancelAuctionButton({ auctionId }: { auctionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={async () => {
        if (
          !confirm(
            'Cancel this auction? All draft + scheduled lots will be canceled. Cannot be undone.',
          )
        )
          return;
        setBusy(true);
        const result = await cancelAuction(auctionId);
        setBusy(false);
        if (!result.ok) {
          alert(result.error);
          return;
        }
        router.push('/auctions');
        router.refresh();
      }}
      disabled={busy}
      style={{ ...secondaryButtonStyle, color: 'var(--danger)' }}
    >
      {busy ? '…' : 'Cancel auction'}
    </button>
  );
}
