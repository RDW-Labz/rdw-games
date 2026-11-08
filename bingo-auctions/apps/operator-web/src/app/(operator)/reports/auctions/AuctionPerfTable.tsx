'use client';

// Auction performance table — client-side search + column sort + a totals
// row (owner ask 2026-07-08: sums, sorters, search on the reporting pages).
// Ratio columns (sell-through, AUR, recovery) are recomputed from the
// aggregate in the totals row so they stay correct, not naive averages.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { StatusPill } from '@/components/console';

export type AuctionPerfRow = {
  id: string;
  title: string;
  status: string;
  endsLabel: string;
  endsAt: string | null;
  lots: number;
  sold: number;
  unsold: number;
  open: number;
  bids: number;
  bidders: number;
  grossCents: number;
  /** 0287: paid lots whose item came back (no-show / forfeit / carried over). */
  returnedLots: number;
  /** 0287: paid lots whose invoice line was refunded. */
  refundedLots: number;
  /** 0287: hammer returned via refunds — already excluded from grossCents. */
  refundedCents: number;
  liveHammerCents: number;
  openBidLots: number;
  msrpSoldCents: number;
};

type SortKey =
  | 'title' | 'status' | 'endsAt' | 'lots' | 'sold' | 'unsold' | 'open'
  | 'sellThrough' | 'bids' | 'bidders' | 'grossCents' | 'returnedLots'
  | 'refundedCents' | 'liveHammerCents' | 'aur' | 'recovery';

function pct(numer: number, denom: number): string {
  if (!denom) return '—';
  return `${Math.round((numer / denom) * 100)}%`;
}

// Sortable-header interaction hooks on top of `.console-table thead th`.
const sortTh: React.CSSProperties = { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
const sortThNum: React.CSSProperties = { ...sortTh, textAlign: 'right' };
// Right-aligned tabular numerics (base padding/border from the class).
const tdNum: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
// Totals row — the class styles thead/tbody only, so the footer carries its
// own padding + heavier top rule.
const footCell: React.CSSProperties = { padding: '11px 12px', borderTop: '2px solid var(--border)' };
const footNum: React.CSSProperties = { ...footCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// Derived value for sorting a row by a computed ratio.
function derived(r: AuctionPerfRow, key: SortKey): number | string | null {
  switch (key) {
    case 'sellThrough': {
      const decided = r.sold + r.unsold;
      return decided ? r.sold / decided : -1;
    }
    case 'aur': {
      const units = r.sold + r.openBidLots;
      return units ? (r.grossCents + r.liveHammerCents) / units : -1;
    }
    case 'recovery':
      return r.msrpSoldCents ? r.grossCents / r.msrpSoldCents : -1;
    default:
      return r[key as keyof AuctionPerfRow] as number | string | null;
  }
}

export function AuctionPerfTable({ rows }: { rows: AuctionPerfRow[] }) {
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('endsAt');
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows;
    if (needle) out = out.filter((r) => r.title.toLowerCase().includes(needle) || r.status.toLowerCase().includes(needle));
    const dir = sortDesc ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = derived(a, sortKey);
      const bv = derived(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, q, sortKey, sortDesc]);

  const t = useMemo(() => {
    const acc = {
      lots: 0, sold: 0, unsold: 0, open: 0, bids: 0, bidders: 0, gross: 0,
      returned: 0, refundedLots: 0, refunded: 0, live: 0, openBidLots: 0, msrp: 0,
    };
    for (const r of filtered) {
      acc.lots += r.lots; acc.sold += r.sold; acc.unsold += r.unsold; acc.open += r.open;
      acc.bids += r.bids; acc.bidders += r.bidders; acc.gross += r.grossCents;
      acc.returned += r.returnedLots; acc.refundedLots += r.refundedLots;
      acc.refunded += r.refundedCents;
      acc.live += r.liveHammerCents; acc.openBidLots += r.openBidLots; acc.msrp += r.msrpSoldCents;
    }
    return acc;
  }, [filtered]);

  const H = (key: SortKey, label: string, numeric = false, title?: string) => (
    <th
      style={numeric ? sortThNum : sortTh}
      title={title}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else { setSortKey(key); setSortDesc(true); }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  const totalSellThrough = pct(t.sold, t.sold + t.unsold);
  const totalAurUnits = t.sold + t.openBidLots;
  const totalAur = totalAurUnits ? formatCents(Math.round((t.gross + t.live) / totalAurUnits)) : '—';
  const totalRecovery = pct(t.gross, t.msrp);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search auction or status…"
          style={{ flex: '1 1 260px', maxWidth: 360, padding: '0.5rem 0.75rem', background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: 8, fontSize: 14 }}
        />
        <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{filtered.length} of {rows.length}</span>
      </div>

      <div className="console-table-card" style={{ overflowX: 'auto' }}>
        <table className="console-table">
          <thead>
            <tr>
              {H('title', 'Auction')}
              {H('status', 'Status')}
              {H('endsAt', 'Ends')}
              {H('lots', 'Lots', true)}
              {H('sold', 'Sold', true)}
              {H('unsold', 'Unsold', true, 'Lots that never sold (no paid invoice line)')}
              {H('open', 'Open', true)}
              {H('sellThrough', 'Sell-through', true, 'Sold ÷ decided lots (sold + never-sold)')}
              {H('bids', 'Bids', true)}
              {H('bidders', 'Bidders', true)}
              {H('grossCents', 'Gross', true, 'Hammer actually PAID, net of refunds. Excludes buyer’s premium and sales tax — so this reads lower than a Square total.')}
              {H('returnedLots', 'Returned', true, 'Paid lots whose item came back — no-show, forfeit, or carried over. Still counted in Gross (you kept the money) unless refunded.')}
              {H('refundedCents', 'Refunded', true, 'Hammer returned to buyers. Already deducted from Gross.')}
              {H('liveHammerCents', 'Live hammer', true, 'Sum of current high bids on still-open lots — the hammer if it closed now')}
              {H('aur', 'AUR', true, 'Average unit rate: (gross + live hammer) ÷ (sold + open lots with bids)')}
              {H('recovery', 'Recovery', true, 'Gross ÷ MSRP of sold lots')}
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const decided = a.sold + a.unsold;
              const aurUnits = a.sold + a.openBidLots;
              const aurCents = a.grossCents + a.liveHammerCents;
              return (
                <tr key={a.id}>
                  <td>
                    <Link href={`/auctions/${a.id}`} style={{ color: 'inherit', textDecoration: 'none', fontWeight: 600 }}>
                      {a.title}
                    </Link>
                  </td>
                  <td><StatusPill status={a.status} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{a.endsLabel}</td>
                  <td style={tdNum}>{a.lots}</td>
                  <td style={tdNum}>{a.sold}</td>
                  <td style={tdNum}>{a.unsold}</td>
                  <td style={tdNum}>{a.open || '—'}</td>
                  <td style={tdNum}>{pct(a.sold, decided)}</td>
                  <td style={tdNum}>{a.bids}</td>
                  <td style={tdNum}>{a.bidders}</td>
                  <td style={tdNum}>{formatCents(a.grossCents)}</td>
                  <td style={tdNum}>{a.returnedLots || '—'}</td>
                  <td style={{ ...tdNum, color: a.refundedCents ? 'var(--danger)' : undefined }}>
                    {a.refundedCents ? `−${formatCents(a.refundedCents)}` : '—'}
                  </td>
                  <td style={tdNum}>{a.liveHammerCents ? formatCents(a.liveHammerCents) : '—'}</td>
                  <td style={tdNum}>{aurUnits ? formatCents(Math.round(aurCents / aurUnits)) : '—'}</td>
                  <td style={tdNum}>{pct(a.grossCents, a.msrpSoldCents)}</td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={16} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  {rows.length ? 'No auctions match your search.' : 'No auctions yet.'}
                </td>
              </tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td style={footCell}>Totals</td>
                <td style={footCell} />
                <td style={footCell} />
                <td style={footNum}>{t.lots}</td>
                <td style={footNum}>{t.sold}</td>
                <td style={footNum}>{t.unsold}</td>
                <td style={footNum}>{t.open || '—'}</td>
                <td style={footNum}>{totalSellThrough}</td>
                <td style={footNum}>{t.bids}</td>
                <td style={footNum}>{t.bidders}</td>
                <td style={footNum}>{formatCents(t.gross)}</td>
                <td style={footNum}>{t.returned || '—'}</td>
                <td style={{ ...footNum, color: t.refunded ? 'var(--danger)' : undefined }}>
                  {t.refunded ? `−${formatCents(t.refunded)}` : '—'}
                </td>
                <td style={footNum}>{t.live ? formatCents(t.live) : '—'}</td>
                <td style={footNum}>{totalAur}</td>
                <td style={footNum}>{totalRecovery}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
