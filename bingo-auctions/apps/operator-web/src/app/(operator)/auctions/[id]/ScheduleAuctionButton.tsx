'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle } from '@/components/Form';
import { scheduleAuction } from '../new/actions';

export function ScheduleAuctionButton({ auctionId }: { auctionId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setLoading(true);
        const result = await scheduleAuction(auctionId);
        setLoading(false);
        if (!result.ok) {
          setErr(result.error);
          return;
        }
        router.refresh();
      }}
      style={{ display: 'inline' }}
    >
      <button type="submit" disabled={loading} style={buttonStyle}>
        {loading ? 'Scheduling…' : 'Schedule auction'}
      </button>
      {err && <div style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
    </form>
  );
}
