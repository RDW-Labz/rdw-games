'use client';

// Segment drill-down for the bidder report. The metrics above it say WHAT is
// happening; this is the part you can act on — the actual people, with contact
// details, ready to hand to a campaign.
//
// Loaded on demand (not with the page) because it returns PII and the lists run
// to hundreds of rows. CSV export is deliberate: the fastest path to a campaign
// today is pasting a list into Square Marketing, which already has the
// "BinGo Auction Bidders" group synced.

import { useState } from 'react';
import { formatCents } from '@auction-platform/shared/money';
import { loadSegment, type SegmentRow, type SegmentKey } from './actions';

const SEGMENTS: Array<{ key: SegmentKey; label: string; why: string }> = [
  {
    key: 'never_bid',
    label: 'Never bid',
    why: 'Registered but has never placed a single bid. Biggest activation pool — they already gave you an email, so reaching them costs nothing.',
  },
  {
    key: 'one_and_done',
    label: 'Bought once',
    why: 'Bought exactly once then stopped. High-value win-back: your repeat buyers average 7+ purchases, so converting one of these is worth many times a single sale.',
  },
  {
    key: 'lapsed',
    label: 'Lapsed buyers',
    why: 'Has bought before but has not bid in 14+ days. Catch them before the habit breaks.',
  },
  {
    key: 'top_spenders',
    label: 'Top spenders',
    why: 'Your best customers by net spend. Cheapest acquisition channel you have — worth a referral ask.',
  },
];

function toCsv(rows: SegmentRow[]): string {
  const head = [
    'bidder_number', 'name', 'email', 'phone',
    'signed_up', 'bids', 'invoices', 'net_spend_usd', 'last_bid', 'last_paid',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.bidder_number ?? '',
      r.display_name ?? '',
      r.email ?? '',
      r.phone ?? '',
      r.signed_up_at ? r.signed_up_at.slice(0, 10) : '',
      r.bids,
      r.invoices,
      (r.net_spend_cents / 100).toFixed(2),
      r.last_bid_at ? r.last_bid_at.slice(0, 10) : '',
      r.last_paid_at ? r.last_paid_at.slice(0, 10) : '',
    ].map(esc).join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

export function BidderSegmentPanel({
  counts,
}: {
  counts: Partial<Record<SegmentKey, number>>;
}) {
  const [active, setActive] = useState<SegmentKey | null>(null);
  const [rows, setRows] = useState<SegmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(key: SegmentKey) {
    if (active === key) {
      setActive(null);
      setRows([]);
      return;
    }
    setActive(key);
    setRows([]);
    setError(null);
    setLoading(true);
    const res = await loadSegment(key);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRows(res.rows);
  }

  function download() {
    if (!active || rows.length === 0) return;
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bingo-${active}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const meta = SEGMENTS.find((s) => s.key === active);

  return (
    <section style={{ marginTop: '2.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Campaign segments</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 820 }}>
        Click a segment to load the people in it. Export the CSV and drop it into Square
        Marketing — your bidders are already synced there as the{' '}
        <em>BinGo Auction Bidders</em> group.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
        {SEGMENTS.map((s) => {
          const on = active === s.key;
          const n = counts[s.key];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => open(s.key)}
              aria-pressed={on}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 14px',
                borderRadius: 999,
                border: '1px solid',
                borderColor: on ? 'var(--accent)' : 'var(--border)',
                background: on ? 'var(--accent-dim)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--fg)',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {s.label}
              {n != null && (
                <span
                  style={{
                    padding: '1px 7px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 800,
                    background: on ? 'var(--accent)' : 'var(--bg-elev)',
                    color: on ? 'var(--bg)' : 'var(--fg-muted)',
                  }}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {meta && (
        <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 0.75rem', maxWidth: 820, lineHeight: 1.55 }}>
          {meta.why}
        </p>
      )}

      {error && (
        <div
          style={{
            padding: '0.7rem 0.9rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 13,
            marginBottom: '0.75rem',
          }}
        >
          {error}
        </div>
      )}

      {loading && <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading…</p>}

      {active && !loading && !error && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              {rows.length} {rows.length === 1 ? 'person' : 'people'}
              {rows.length >= 500 ? ' (capped at 500)' : ''}
            </span>
            <button
              type="button"
              onClick={download}
              disabled={rows.length === 0}
              style={{
                padding: '5px 12px',
                background: 'transparent',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
                cursor: rows.length === 0 ? 'not-allowed' : 'pointer',
                opacity: rows.length === 0 ? 0.5 : 1,
              }}
            >
              Export CSV
            </button>
          </div>

          {rows.length === 0 ? (
            <div
              style={{
                padding: 24,
                border: '1px dashed var(--border)',
                borderRadius: 8,
                textAlign: 'center',
                color: 'var(--fg-muted)',
                fontSize: 13,
              }}
            >
              Nobody in this segment. 🎉
            </div>
          ) : (
            <div className="console-table-card" style={{ overflowX: 'auto', maxHeight: 520 }}>
              <table className="console-table">
                <thead>
                  <tr>
                    <th>Bidder</th>
                    <th>Contact</th>
                    <th style={{ textAlign: 'right' }}>Signed up</th>
                    <th style={{ textAlign: 'right' }}>Bids</th>
                    <th style={{ textAlign: 'right' }}>Orders</th>
                    <th style={{ textAlign: 'right' }}>Net spend</th>
                    <th style={{ textAlign: 'right' }}>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.bidder_id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.display_name ?? '—'}</div>
                        {r.bidder_number != null && (
                          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                            #{r.bidder_number}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <div>{r.email ?? '—'}</div>
                        {r.phone && (
                          <div style={{ color: 'var(--fg-muted)' }}>{r.phone}</div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {r.signed_up_at ? r.signed_up_at.slice(0, 10) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.bids}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.invoices}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {r.net_spend_cents ? formatCents(r.net_spend_cents) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>
                        {(r.last_bid_at ?? r.last_paid_at)?.slice(0, 10) ?? 'never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
