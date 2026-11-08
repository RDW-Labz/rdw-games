'use client';

// Pickup-sessions rollout switch on the staff pickups dashboard (mig 0241).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setPickupSessionsEnabled } from './actions';

export function SessionsToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await setPickupSessionsEnabled(!enabled);
      if (!res.ok) setError(res.error);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0.6rem 0.9rem',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-elev)',
        marginBottom: '1rem',
        fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 700 }}>Pickup pass (one QR per customer)</span>
      <span style={{ color: enabled ? 'var(--accent)' : 'var(--fg-dim)', fontWeight: 800 }}>
        {enabled ? 'ON' : 'OFF'}
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={flip}
        style={{ padding: '0.35rem 0.9rem', fontSize: 12, cursor: busy ? 'wait' : 'pointer' }}
      >
        {busy ? '…' : enabled ? 'Turn off' : 'Turn on'}
      </button>
      <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
        Bidders get an aisle-ordered walk list + one checkout QR at /profile/pickup-pass.
      </span>
      {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}
