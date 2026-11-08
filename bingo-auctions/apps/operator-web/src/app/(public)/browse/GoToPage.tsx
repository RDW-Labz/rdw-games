'use client';

// Go-to-page jump box for BrowsePaginator (customer report 2026-07-09:
// "Page 1 of 101" with only Prev/Next meant re-tapping Next ~50 times to
// get back to where she left off).
//
// baseHref is the page-1 href (always contains a query string — both browse
// views set `view=`), so page N is just `${baseHref}&page=N`.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GoToPage({ pageCount, baseHref }: { pageCount: number; baseHref: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');

  function go() {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > pageCount) return;
    router.push(n === 1 ? baseHref : `${baseHref}&page=${n}`);
    setValue('');
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
    >
      <label htmlFor="goto-page" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        Go to
      </label>
      <input
        id="goto-page"
        type="number"
        inputMode="numeric"
        min={1}
        max={pageCount}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`1–${pageCount}`}
        style={{
          width: 72,
          padding: '0.4rem 0.5rem',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--fg)',
        }}
      />
      <button
        type="submit"
        className="btn-secondary"
        style={{ padding: '0.4rem 0.8rem', fontSize: 13, cursor: 'pointer' }}
      >
        Go
      </button>
    </form>
  );
}
