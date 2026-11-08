'use client';

// S12: Customer-search box for the pickups page.
// Calls staff_search_bidder_invoices via the searchCustomers server action.
// Each result links to the invoice detail page (/invoices/<id>).

import { useState, useRef } from 'react';
import { searchCustomers, type CustomerSearchRow } from './actions';
import { inputStyle } from '@/components/Form';

export function CustomerSearch({
  warehouseQuery,
  heading = 'Customer search',
}: {
  warehouseQuery?: string | null;
  /** Visible label above the box (console v2 says "Find customer"). */
  heading?: string;
}) {
  const invoiceQuery = warehouseQuery
    ? `?warehouse=${encodeURIComponent(warehouseQuery)}`
    : '';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerSearchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timerRef.current = setTimeout(() => void runSearch(q.trim()), 400);
  }

  async function runSearch(q: string) {
    setBusy(true);
    try {
      const res = await searchCustomers(q);
      if (!res.ok) {
        setError(res.error);
        setResults([]);
        return;
      }
      setResults(res.results);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1rem', color: 'var(--fg)', marginBottom: '0.5rem' }}>
        {heading}
      </h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '0.75rem', margin: '0 0 0.75rem' }}>
        Find a paid invoice by customer name, email, or phone number.
      </p>

      <input
        type="search"
        value={query}
        onChange={onQueryChange}
        placeholder="Name, email, or phone…"
        aria-label="Search customers"
        style={{ ...inputStyle, width: '100%', maxWidth: 400, boxSizing: 'border-box' }}
      />

      {busy && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>
          Searching…
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', margin: '0.5rem 0 0' }}>
          {error}
        </p>
      )}

      {!busy && query.trim().length >= 2 && results.length === 0 && !error && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>
          No paid invoices found.
        </p>
      )}

      {results.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0', display: 'grid', gap: '0.5rem' }}>
          {results.map((r) => (
            <li
              key={r.invoice_id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem 1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                gap: '1rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {r.display_name ?? r.email}
                </div>
                {r.display_name && (
                  <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{r.email}</div>
                )}
                <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                  ${(r.total_cents / 100).toFixed(2)} &middot;{' '}
                  {new Date(r.created_at).toLocaleDateString()}
                </div>
              </div>
              <a
                href={`/invoices/${r.invoice_id}${invoiceQuery}`}
                style={{
                  padding: '0.4rem 0.9rem',
                  background: 'var(--accent)',
                  color: '#fff',
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                View invoice
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
