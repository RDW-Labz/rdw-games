'use client';

// Optional custom date-range filter for the Reports page (owner ask
// 2026-07-08 — reporting needs date filters, not only month-at-a-time).
// When From/To are set, the page reports on [from, to]; "Clear" drops back
// to the month view (MonthNav). Dates are plain YYYY-MM-DD and interpreted
// in the operator's warehouse zone server-side.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';

export function DateRangeNav({ from, to }: { from: string | null; to: string | null }) {
  const router = useRouter();
  const [f, setF] = useState(from ?? '');
  const [t, setT] = useState(to ?? '');

  const apply = () => {
    if (!f || !t) return;
    router.push(`/reports?from=${f}&to=${t}`);
  };
  const clear = () => {
    setF('');
    setT('');
    router.push('/reports');
  };

  const input: React.CSSProperties = {
    padding: '0.35rem 0.5rem',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
    borderRadius: 6,
    fontSize: 13,
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Or custom range:</span>
      <input type="date" value={f} max={t || undefined} onChange={(e) => setF(e.target.value)} style={input} aria-label="From date" />
      <span style={{ color: 'var(--fg-muted)' }}>→</span>
      <input type="date" value={t} min={f || undefined} onChange={(e) => setT(e.target.value)} style={input} aria-label="To date" />
      <button type="button" onClick={apply} disabled={!f || !t} style={{ ...buttonStyle, padding: '0.35rem 0.9rem', fontSize: 13, opacity: !f || !t ? 0.5 : 1 }}>
        Apply
      </button>
      {(from || to) && (
        <button type="button" onClick={clear} style={{ ...secondaryButtonStyle, padding: '0.35rem 0.9rem', fontSize: 13 }}>
          Clear
        </button>
      )}
    </div>
  );
}
