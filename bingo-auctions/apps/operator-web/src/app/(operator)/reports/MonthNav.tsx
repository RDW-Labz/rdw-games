'use client';

import Link from 'next/link';
import { secondaryButtonStyle } from '@/components/Form';

function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    slug: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

export function MonthNav({ year, month }: { year: number; month: number }) {
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}
    >
      <Link
        href={`/reports?month=${prev.slug}`}
        style={{ ...secondaryButtonStyle, textDecoration: 'none', padding: '0.3rem 0.7rem' }}
      >
        &larr;
      </Link>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {!isCurrentMonth && (
        <Link
          href={`/reports?month=${next.slug}`}
          style={{ ...secondaryButtonStyle, textDecoration: 'none', padding: '0.3rem 0.7rem' }}
        >
          &rarr;
        </Link>
      )}
    </div>
  );
}
