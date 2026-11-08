'use client';

// ZIP heat table section of /reports/bidder-insights. Sortable (click a
// header), with a ZIP-prefix filter (?zip=) and a CSV export link that
// carries the same from/to/zip the screen shows. Aggregates only.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatCents } from '@auction-platform/shared/money';
import { secondaryButtonStyle } from '@/components/Form';
import { OTHER_ZIP, UNKNOWN_ZIP } from '@/lib/bidder-location';
import {
  sortZipHeatRows,
  zipHeatTotals,
  type RpcState,
  type ZipHeatRow,
  type ZipHeatSortKey,
} from '@/lib/bidder-insights';

const th: React.CSSProperties = { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted: React.CSSProperties = { color: 'var(--fg-muted)' };

function Notice({ tone, children }: { tone: 'calm' | 'danger'; children: React.ReactNode }) {
  const danger = tone === 'danger';
  return (
    <div
      role="status"
      style={{
        padding: '1rem',
        border: danger ? '1px solid rgba(255,84,112,0.4)' : '1px solid var(--border)',
        background: danger ? 'rgba(255,84,112,0.08)' : 'var(--bg-elev)',
        borderRadius: 8,
        color: danger ? 'var(--danger)' : 'var(--fg)',
        fontSize: 14,
        marginBottom: '1rem',
      }}
    >
      {children}
    </div>
  );
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  align,
}: {
  label: string;
  col: ZipHeatSortKey;
  sort: { key: ZipHeatSortKey; dir: 'asc' | 'desc' };
  onSort: (key: ZipHeatSortKey) => void;
  align?: 'right';
}) {
  const active = sort.key === col;
  return (
    <th style={{ ...th, textAlign: align ?? 'left' }} onClick={() => onSort(col)}>
      {label}
      {active ? <span style={{ marginLeft: 4, color: 'var(--accent)' }}>{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
    </th>
  );
}

export function ZipHeatSection({
  state,
  zipPrefix,
  periodLabel,
}: {
  state: RpcState<ZipHeatRow>;
  zipPrefix: string | null;
  periodLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [zip, setZip] = useState(zipPrefix ?? '');
  const [sort, setSort] = useState<{ key: ZipHeatSortKey; dir: 'asc' | 'desc' }>({
    key: 'paidRevenueCents',
    dir: 'desc',
  });

  const applyZip = (value: string) => {
    const q = new URLSearchParams(params?.toString() ?? '');
    if (value) q.set('zip', value);
    else q.delete('zip');
    const qs = q.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const onSort = (key: ZipHeatSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const exportHref = useMemo(() => {
    const q = new URLSearchParams(params?.toString() ?? '');
    return `/reports/bidder-insights/export${q.toString() ? `?${q.toString()}` : ''}`;
  }, [params]);

  return (
    <section style={{ marginBottom: '2.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>ZIP heat table</h2>
      <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 0.75rem', maxWidth: 820 }}>
        Registered is lifetime; active is a fixed rolling 30-day window; winners and revenue honour the date range
        above. ZIP groups under 3 registered bidders roll into &ldquo;{OTHER_ZIP}&rdquo; and bidders with no ZIP are
        &ldquo;{UNKNOWN_ZIP}&rdquo;. City names appear once the ZIP list is loaded.
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyZip(zip.trim());
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
              ZIP starts with
            </span>
            <input
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              inputMode="numeric"
              placeholder="e.g. 726"
              aria-label="ZIP prefix"
              style={{
                padding: '0.35rem 0.5rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                color: 'var(--fg)',
                borderRadius: 6,
                fontSize: 13,
                width: 90,
              }}
            />
          </label>
          <button type="submit" style={secondaryButtonStyle}>
            Apply
          </button>
          {zipPrefix && (
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                setZip('');
                applyZip('');
              }}
            >
              Clear
            </button>
          )}
        </form>
        {state.kind === 'ok' && (
          <a href={exportHref} style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            Export CSV
          </a>
        )}
      </div>

      {state.kind === 'needs_migration' && (
        <Notice tone="calm">
          This report needs migration 0449 (bidder insights). It will fill in once that migration is applied;
          nothing else in the console is affected.
        </Notice>
      )}
      {state.kind === 'forbidden' && <p style={muted}>Admins or managers only.</p>}
      {state.kind === 'error' && <Notice tone="danger">Couldn&apos;t load the ZIP heat table: {state.message}</Notice>}

      {state.kind === 'ok' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 0.5rem' }}>{periodLabel}</p>
          <div className="console-table-card" style={{ overflowX: 'auto' }}>
            <table className="console-table">
              <thead>
                <tr>
                  <SortHeader label="ZIP" col="postalCode" sort={sort} onSort={onSort} />
                  <SortHeader label="Registered" col="registered" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Active (30d)" col="activeBidders30d" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Winners" col="winners" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Paid revenue" col="paidRevenueCents" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Share" col="shareBps" sort={sort} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {state.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                      No bidders match this filter.
                    </td>
                  </tr>
                ) : (
                  sortZipHeatRows(state.rows, sort.key, sort.dir).map((r) => (
                    <tr key={r.postalCode}>
                      <td>{r.postalCode}</td>
                      <td style={num}>{r.registered}</td>
                      <td style={num}>{r.activeBidders30d}</td>
                      <td style={num}>{r.winners}</td>
                      <td style={num}>{formatCents(r.paidRevenueCents)}</td>
                      <td style={num}>{r.shareBps == null ? '—' : `${(r.shareBps / 100).toFixed(1)}%`}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {state.rows.length > 0 &&
                (() => {
                  const t = zipHeatTotals(state.rows);
                  return (
                    <tfoot>
                      <tr style={{ fontWeight: 700 }}>
                        <td style={{ borderTop: '2px solid var(--border)' }}>Total</td>
                        <td style={{ ...num, borderTop: '2px solid var(--border)' }}>{t.registered}</td>
                        <td style={{ ...num, borderTop: '2px solid var(--border)' }}>{t.activeBidders30d}</td>
                        <td style={{ ...num, borderTop: '2px solid var(--border)' }}>{t.winners}</td>
                        <td style={{ ...num, borderTop: '2px solid var(--border)' }}>{formatCents(t.paidRevenueCents)}</td>
                        <td style={{ ...num, borderTop: '2px solid var(--border)' }}>
                          {t.shareBps == null ? '—' : `${(t.shareBps / 100).toFixed(1)}%`}
                        </td>
                      </tr>
                    </tfoot>
                  );
                })()}
            </table>
          </div>
        </>
      )}
    </section>
  );
}
