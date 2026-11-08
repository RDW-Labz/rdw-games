'use client';

// Reports invoice table — client-side search + column sort + a totals row.
// Money is broken out so "what's in the number" is never ambiguous
// (owner ask 2026-07-08): Hammer (winning bids) · Buyer's premium · Sales
// tax (pass-through, NOT your revenue) · Total collected · Net revenue
// (= hammer + premium). Rows are pre-formatted server-side (paid date in the
// warehouse zone) so this component stays presentation-only.
//
// 2026-10-14 (mig 0418): `rows` is ONE PAGE of the period's invoices. The
// "Period total" footer row comes from `periodTotals` (computed in the DB over
// every invoice); the row-sum footer only appears, labelled as such, when the
// rows shown are a subset (another page exists, or a search is active).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { invoiceHref } from '@/lib/console-links';
import type { ReportPeriodTotals } from './report-totals';

export type ReportInvoiceRow = {
  id: string;
  auctionId: string | null;
  auctionTitle: string;
  bidderId: string | null;
  bidderName: string;
  hammerCents: number;
  premiumCents: number;
  taxCents: number;
  totalCents: number;
  netCents: number;
  paidAt: string | null;
  paidLabel: string;
};

type SortKey = 'auctionTitle' | 'bidderName' | 'hammerCents' | 'premiumCents' | 'taxCents' | 'totalCents' | 'netCents' | 'paidAt';

// Sortable-header hooks layered on top of `.console-table thead th` (which
// supplies the uppercase-muted chrome). Only the interaction bits live here.
const sortTh: React.CSSProperties = { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
const sortThNum: React.CSSProperties = { ...sortTh, textAlign: 'right' };
// Right-aligned tabular numerics for money cells (base padding/border come
// from `.console-table tbody td`).
const tdNum: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
// Totals row — the class only styles thead/tbody, so the footer carries its
// own padding + a heavier top rule to separate it from the body.
const footCell: React.CSSProperties = { padding: '11px 12px', borderTop: '2px solid var(--border)' };
const footNum: React.CSSProperties = { ...footCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 };

export function ReportsInvoicesTable({
  rows,
  periodTotals,
  pageInfo,
}: {
  rows: ReportInvoiceRow[];
  periodTotals: ReportPeriodTotals | null;
  pageInfo: { pageCount: number };
}) {
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('paidAt');
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows;
    if (needle) {
      out = out.filter((r) =>
        [r.auctionTitle, r.bidderName].some((v) => v.toLowerCase().includes(needle)),
      );
    }
    const dir = sortDesc ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, q, sortKey, sortDesc]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.hammer += r.hammerCents;
          acc.premium += r.premiumCents;
          acc.tax += r.taxCents;
          acc.total += r.totalCents;
          acc.net += r.netCents;
          return acc;
        },
        { hammer: 0, premium: 0, tax: 0, total: 0, net: 0 },
      ),
    [filtered],
  );

  const isPaged = pageInfo.pageCount > 1;
  const showSubsetRow = isPaged || filtered.length !== rows.length;
  const subsetLabel = filtered.length !== rows.length ? 'Matching rows' : 'This page';

  const sortableHeader = (key: SortKey, label: string, numeric = false, title?: string) => (
    <th
      style={numeric ? sortThNum : sortTh}
      title={title}
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search auction or customer…"
          style={{
            flex: '1 1 260px',
            maxWidth: 360,
            padding: '0.5rem 0.75rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            borderRadius: 8,
            fontSize: 14,
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          {filtered.length} of {rows.length}
          {isPaged && periodTotals
            ? ` on this page · ${periodTotals.invoices.toLocaleString()} in period`
            : ''}
        </span>
      </div>

      <div className="console-table-card" style={{ overflowX: 'auto' }}>
        <table className="console-table">
          <thead>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>Invoice</th>
              {sortableHeader('auctionTitle', 'Auction')}
              {sortableHeader('bidderName', 'Customer')}
              {sortableHeader('hammerCents', 'Hammer', true, 'Winning bid total (the price the lot hammered at)')}
              {sortableHeader('premiumCents', "Buyer's prem", true, "Buyer's premium added on top of the hammer")}
              {sortableHeader('taxCents', 'Sales tax', true, 'Sales tax collected — pass-through, owed to the state, NOT your revenue')}
              {sortableHeader('totalCents', 'Total', true, 'Total charged to the customer = hammer + premium + tax')}
              {sortableHeader('netCents', 'Net revenue', true, 'Your revenue = hammer + buyer’s premium (tax excluded)')}
              {sortableHeader('paidAt', 'Paid', true)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={invoiceHref(r.id)}>View →</Link>
                </td>
                <td>
                  {r.auctionId ? (
                    <Link href={`/auctions/${r.auctionId}`}>{r.auctionTitle}</Link>
                  ) : (
                    r.auctionTitle
                  )}
                </td>
                <td>
                  {r.bidderId ? (
                    <Link href={`/bidders/${r.bidderId}`}>{r.bidderName}</Link>
                  ) : (
                    r.bidderName
                  )}
                </td>
                <td style={tdNum}>{formatCents(r.hammerCents)}</td>
                <td style={tdNum}>{formatCents(r.premiumCents)}</td>
                <td style={{ ...tdNum, color: 'var(--fg-muted)' }}>{formatCents(r.taxCents)}</td>
                <td style={tdNum}>{formatCents(r.totalCents)}</td>
                <td style={{ ...tdNum, fontWeight: 600 }}>{formatCents(r.netCents)}</td>
                <td style={{ ...tdNum, whiteSpace: 'nowrap' }}>{r.paidLabel}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  {rows.length ? 'No rows match your search.' : 'No paid invoices in this period.'}
                </td>
              </tr>
            )}
          </tbody>
          {(filtered.length > 0 || periodTotals) && (
            <tfoot>
              {showSubsetRow && filtered.length > 0 && (
                <tr>
                  <td style={footCell} />
                  <td style={{ ...footCell, fontWeight: 600, color: 'var(--fg-muted)' }}>{subsetLabel}</td>
                  <td style={{ ...footCell, color: 'var(--fg-muted)' }}>{filtered.length} invoice{filtered.length === 1 ? '' : 's'}</td>
                  <td style={{ ...footNum, fontWeight: 600 }}>{formatCents(totals.hammer)}</td>
                  <td style={{ ...footNum, fontWeight: 600 }}>{formatCents(totals.premium)}</td>
                  <td style={{ ...footNum, fontWeight: 600, color: 'var(--fg-muted)' }}>{formatCents(totals.tax)}</td>
                  <td style={{ ...footNum, fontWeight: 600 }}>{formatCents(totals.total)}</td>
                  <td style={{ ...footNum, fontWeight: 600 }}>{formatCents(totals.net)}</td>
                  <td style={footCell} />
                </tr>
              )}
              {periodTotals && (
                <tr>
                  <td style={footCell} />
                  <td style={{ ...footCell, fontWeight: 700 }}>Period total</td>
                  <td style={{ ...footCell, color: 'var(--fg-muted)' }}>
                    {periodTotals.invoices.toLocaleString()} invoice{periodTotals.invoices === 1 ? '' : 's'}
                  </td>
                  <td style={footNum}>{formatCents(periodTotals.hammerCents)}</td>
                  <td style={footNum}>{formatCents(periodTotals.premiumCents)}</td>
                  <td style={{ ...footNum, color: 'var(--fg-muted)' }}>{formatCents(periodTotals.taxCents)}</td>
                  <td style={footNum}>{formatCents(periodTotals.totalCents)}</td>
                  <td style={{ ...footNum, color: 'var(--accent)' }}>{formatCents(periodTotals.netCents)}</td>
                  <td style={footCell} />
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
