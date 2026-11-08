// Result half of /reports/bidder-zips: banner, coverage line, table + totals.
// Kept free of data fetching and client hooks so it renders in a unit test
// for each RPC state (incl. the pre-0434 "needs migration" banner).
// Aggregates only: the rows carry counts and cents, never a person.

import { formatCents } from '@auction-platform/shared/money';
import {
  CC_BY_URL,
  GEONAMES_URL,
  bidderLocationTotals,
  cityLabel,
  coverageLine,
  sortBidderLocationRows,
  NO_ACTIVITY_LOCATION,
  OTHER_ZIP,
  UNKNOWN_ZIP,
  UNLISTED_ZIP,
  type BidderLocationState,
  type ZipCoverage,
} from '@/lib/bidder-location';

const num: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

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

export function BidderZipBody({
  state,
  zipPrefix,
  coverage,
  showPlaces = false,
  placeFilter = null,
}: {
  state: BidderLocationState;
  zipPrefix: string | null;
  /** From operator_bidder_zip_coverage(); null hides the line (fail-soft). */
  coverage: ZipCoverage | null;
  /** mig 0438 is applied: City column + the GeoNames credit (CC BY 4.0 requires it). */
  showPlaces?: boolean;
  /** e.g. 'Springdale, AR' or 'AR' when a place filter is on. */
  placeFilter?: string | null;
}) {
  if (state.kind === 'needs_migration') {
    return (
      <Notice tone="calm">
        This report needs migration 0434 (bidder ZIP codes). It will fill in once that migration
        is applied; nothing else in the console is affected.
      </Notice>
    );
  }
  if (state.kind === 'forbidden') {
    return <p style={muted}>Admins or managers only.</p>;
  }
  if (state.kind === 'error') {
    return <Notice tone="danger">Couldn&apos;t load bidders by ZIP: {state.message}</Notice>;
  }

  const rows = sortBidderLocationRows(state.rows);
  const t = bidderLocationTotals(rows);

  return (
    <>
      {zipPrefix ? (
        <p style={{ fontSize: 14, margin: '0 0 1rem', color: 'var(--fg-muted)' }}>
          ZIP coverage is shown without a ZIP filter (bidders with no ZIP never match a prefix).
        </p>
      ) : placeFilter ? (
        <p style={{ fontSize: 14, margin: '0 0 1rem', color: 'var(--fg-muted)' }}>
          ZIP coverage is shown without a city or state filter (bidders with no ZIP never match one).
        </p>
      ) : coverage ? (
        <p style={{ fontSize: 14, margin: '0 0 1rem' }}>
          <strong>{coverageLine(coverage)}.</strong>{' '}
          <span style={{ color: 'var(--fg-muted)' }}>Each bidder counted once, across all locations.</span>
        </p>
      ) : null}

      <section style={{ marginBottom: '2rem' }}>
        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>ZIP</th>
                {showPlaces && <th>City</th>}
                <th>Auction location</th>
                <th style={{ textAlign: 'right' }}>Registered</th>
                <th style={{ textAlign: 'right' }}>Active bidders</th>
                <th style={{ textAlign: 'right' }}>Buyers</th>
                <th style={{ textAlign: 'right' }}>Paid invoices</th>
                <th style={{ textAlign: 'right' }}>Sales (net, excl. tax)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={showPlaces ? 8 : 7} style={muted}>
                    No bidders match these filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const special = r.postalCode === UNKNOWN_ZIP || r.postalCode === OTHER_ZIP;
                return (
                  <tr key={`${r.postalCode}|${r.warehouseId ?? r.warehouseName}`}>
                    <td
                      style={{
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                        color: special ? 'var(--fg-muted)' : undefined,
                      }}
                    >
                      {r.postalCode}
                    </td>
                    {showPlaces && (
                      <td style={special || !r.city ? muted : undefined}>{cityLabel(r)}</td>
                    )}
                    <td style={r.warehouseName === NO_ACTIVITY_LOCATION ? muted : undefined}>
                      {r.warehouseName}
                    </td>
                    <td style={num}>{r.registered}</td>
                    <td style={num}>{r.activeBidders}</td>
                    <td style={num}>{r.buyers}</td>
                    <td style={num}>{r.paidInvoices}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{formatCents(r.salesNetCents)}</td>
                  </tr>
                );
              })}
              {rows.length > 0 && (
                <tr>
                  <td style={{ fontWeight: 800, borderTop: '2px solid var(--border)' }}>Total</td>
                  {showPlaces && <td style={{ borderTop: '2px solid var(--border)' }} />}
                  <td style={{ borderTop: '2px solid var(--border)' }} />
                  <td style={{ ...num, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{t.registered}</td>
                  <td style={{ ...num, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{t.activeBidders}</td>
                  <td style={{ ...num, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{t.buyers}</td>
                  <td style={{ ...num, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{t.paidInvoices}</td>
                  <td style={{ ...num, fontWeight: 800, borderTop: '2px solid var(--border)' }}>
                    {formatCents(t.salesNetCents)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.5rem 0 0', maxWidth: 860 }}>
          Registered = bidder accounts; active bidders = placed a bid; buyers = paid an invoice.
          Location is the auction&apos;s warehouse; &ldquo;{NO_ACTIVITY_LOCATION}&rdquo; = registered
          but no activity in the window. Sales are net of tax and refunds. {UNKNOWN_ZIP} = the
          bidder hasn&apos;t given a ZIP. ZIPs with fewer than 3 bidders are combined into
          &ldquo;{OTHER_ZIP}&rdquo; so no one can be singled out. Total = sum of the rows above.
          {showPlaces && (
            <>
              {' '}City = the ZIP&apos;s main post-office place; &ldquo;{UNLISTED_ZIP}&rdquo; = a ZIP
              the table doesn&apos;t list (it drops out under a city or state filter). A city or state
              with fewer than 3 bidders shows no rows.
            </>
          )}
        </p>
        {showPlaces && (
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>
            ZIP places ©{' '}
            <a href={GEONAMES_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
              GeoNames
            </a>
            ,{' '}
            <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
              CC BY 4.0
            </a>
          </p>
        )}
      </section>
    </>
  );
}
