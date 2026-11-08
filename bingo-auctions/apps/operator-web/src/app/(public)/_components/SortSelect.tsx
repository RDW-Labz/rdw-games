'use client';

// SortSelect — the always-visible sort dropdown in the browse toolbar.
//
// 2026-07-05 bidder-QoL: sorting used to live ONLY at the bottom of the
// Filters panel — on mobile that's behind the Filters button and three
// sections of scrolling, so bidders concluded sorting didn't exist ("I
// couldn't sort by highest bids"). This sits next to the result count and
// mirrors the same URL params the rail uses, so the two controls stay in
// sync via the URL.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SortOption } from './FilterRail';

const OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'ending-soon', label: 'Ending soon' },
  { value: 'newest', label: 'Newly listed' },
  { value: 'most-bids', label: 'Most bids' },
  { value: 'price-high', label: 'Current bid: high to low' },
  { value: 'price-low', label: 'Current bid: low to high' },
];

export function SortSelect({ sort }: { sort: SortOption }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const qs = new URLSearchParams(searchParams.toString());
    if (value === 'ending-soon') qs.delete('sort');
    else qs.set('sort', value);
    qs.delete('page'); // new ordering restarts pagination
    const suffix = qs.toString();
    router.push(suffix ? `${pathname}?${suffix}` : pathname);
  }

  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
        Sort
      </span>
      <select
        value={sort}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Sort lots by"
        style={{
          padding: '0.45rem 2rem 0.45rem 0.65rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--fg)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M6 8L1 3h10z' fill='%235a6276'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.65rem center',
        }}
      >
        {OPTIONS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
