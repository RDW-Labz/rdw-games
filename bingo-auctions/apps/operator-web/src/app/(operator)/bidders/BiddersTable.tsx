'use client';

// Customer directory table (mig 0235). Receives the full bidder directory
// from operator_bidder_directory() and does search / filter / sort / CSV
// client-side — trivial at hundreds of rows, zero extra round trips.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FilterPills } from '@/components/console';
import { isExactBidderNumber, matchesBidderSearch, parseBidderSearch } from './bidder-search';

export type DirectoryRow = {
  id: string;
  display_name: string | null;
  /** 0423; absent until that migration is applied. */
  bidder_number?: number | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  has_card: boolean;
  marketing_emails_enabled: boolean;
  tax_exempt: boolean;
  resale_cert_status: string | null;
  resale_cert_submitted_at: string | null;
  referral_code: string | null;
  was_referred: boolean;
  referred_count: number;
  credit_balance_cents: number;
  bids_total: number;
  last_bid_at: string | null;
  invoices_paid: number;
  lifetime_spend_cents: number;
  unpaid_cents: number;
  suspended: boolean;
};

type SortKey = 'created_at' | 'last_bid_at' | 'bids_total' | 'lifetime_spend_cents' | 'unpaid_cents';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'resale_pending', label: 'Resale pending' },
  { key: 'no_card', label: 'No card' },
  { key: 'unpaid', label: 'Owes money' },
  { key: 'active_7d', label: 'Bid in 7d' },
  { key: 'never_bid', label: 'Never bid' },
  { key: 'suspended', label: 'Suspended' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function fmtDate(iso: string | null, tz: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
  });
}

export function BiddersTable({
  rows,
  tz,
  initialFilter = 'all',
}: {
  rows: DirectoryRow[];
  tz: string;
  initialFilter?: FilterKey;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const search = parseBidderSearch(q);
    const weekAgo = Date.now() - 7 * 86400_000;
    let out = rows;
    if (search.needle) {
      out = out.filter((r) => matchesBidderSearch(r, search));
    }
    switch (filter) {
      case 'resale_pending':
        out = out.filter((r) => r.resale_cert_status === 'pending');
        break;
      case 'no_card':
        out = out.filter((r) => !r.has_card);
        break;
      case 'unpaid':
        out = out.filter((r) => r.unpaid_cents > 0);
        break;
      case 'active_7d':
        out = out.filter((r) => r.last_bid_at && new Date(r.last_bid_at).getTime() > weekAgo);
        break;
      case 'never_bid':
        out = out.filter((r) => r.bids_total === 0);
        break;
      case 'suspended':
        out = out.filter((r) => r.suspended);
        break;
    }
    const dir = sortDesc ? -1 : 1;
    return [...out].sort((a, b) => {
      // An exact bidder-number hit goes to the top of the results.
      const ae = isExactBidderNumber(a, search);
      const be = isExactBidderNumber(b, search);
      if (ae !== be) return ae ? -1 : 1;
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, q, filter, sortKey, sortDesc]);

  const exportCsv = () => {
    const cols = [
      'bidder_number', 'display_name', 'email', 'phone', 'created_at', 'has_card', 'bids_total',
      'last_bid_at', 'invoices_paid', 'lifetime_spend_cents', 'unpaid_cents',
      'credit_balance_cents', 'referral_code', 'referred_count', 'tax_exempt',
      'marketing_emails_enabled', 'suspended',
    ] as const;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      cols.join(','),
      ...filtered.map((r) => cols.map((c) => esc(r[c])).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bidders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sortHeader = (key: SortKey, label: string) => (
    <th
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else {
          setSortKey(key);
          setSortDesc(true);
        }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search #bidder number, name, email, phone, code…"
          style={{
            flex: '1 1 240px',
            maxWidth: 340,
            padding: '0.55rem 0.8rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            borderRadius: 8,
            fontSize: 14,
          }}
        />
        <FilterPills
          aria-label="Filter bidders"
          options={FILTERS.map((f) => ({ value: f.key, label: f.label }))}
          active={filter}
          onSelect={(v) => setFilter(v as FilterKey)}
        />
        <span style={{ fontSize: 13, color: 'var(--fg-muted)', marginLeft: 'auto' }}>
          {filtered.length} of {rows.length}
        </span>
        <button
          type="button"
          className="btn-secondary"
          onClick={exportCsv}
          style={{ padding: '0.45rem 0.9rem', fontSize: 13, cursor: 'pointer' }}
        >
          Export CSV
        </button>
      </div>

      <div className="console-table-card" style={{ overflowX: 'auto' }}>
        <table className="console-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Customer</th>
              <th>Phone</th>
              {sortHeader('created_at', 'Joined')}
              {sortHeader('bids_total', 'Bids')}
              {sortHeader('last_bid_at', 'Last bid')}
              {sortHeader('lifetime_spend_cents', 'Spent')}
              {sortHeader('unpaid_cents', 'Owes')}
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {r.bidder_number != null ? `#${r.bidder_number}` : '—'}
                </td>
                <td>
                  <Link href={`/bidders/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div style={{ fontWeight: 600 }}>{r.display_name ?? '—'}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.email ?? '—'}</div>
                  </Link>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.phone ? (
                    <a href={`tel:${r.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {r.phone}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--fg-dim)' }}>—</span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at, tz)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.bids_total}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.last_bid_at, tz)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {r.lifetime_spend_cents > 0 ? money(r.lifetime_spend_cents) : '—'}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {r.unpaid_cents > 0 ? (
                    <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{money(r.unpaid_cents)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                    {r.resale_cert_status === 'pending' && <Pill text="Resale pending" tone="warn" />}
                    {!r.has_card && <Pill text="No card" tone="warn" />}
                    {r.tax_exempt && <Pill text="Tax exempt" tone="ok" />}
                    {r.credit_balance_cents > 0 && <Pill text={`${money(r.credit_balance_cents)} credit`} tone="ok" />}
                    {r.referred_count > 0 && <Pill text={`${r.referred_count} referred`} tone="ok" />}
                    {r.was_referred && <Pill text="Referred" tone="neutral" />}
                    {!r.marketing_emails_enabled && <Pill text="No marketing" tone="neutral" />}
                    {r.suspended && <Pill text="Suspended" tone="bad" />}
                  </span>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  No bidders match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pill({ text, tone }: { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  // Tokens only — matches the console color language (success/warning/danger
  // from globals.css) instead of the old off-token hexes (Operator Console
  // handoff Wave 0, 2026-07-13).
  const colors: Record<string, { bg: string; fg: string }> = {
    ok: { bg: 'var(--success-dim)', fg: 'var(--success)' },
    warn: { bg: 'var(--warning-dim)', fg: 'var(--warning)' },
    bad: { bg: 'var(--urgent-red-dim)', fg: 'var(--danger)' },
    neutral: { bg: 'var(--bg-elev)', fg: 'var(--fg-muted)' },
  };
  const c = colors[tone]!;
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '0.1rem 0.5rem',
        borderRadius: 12,
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}
