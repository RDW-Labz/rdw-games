// Activity segments section of /reports/bidder-insights: 5 KPI tiles
// (platform-wide, as of now) plus a per-ZIP breakdown table. Server
// component — no interactivity needed. Aggregates only.

import { KpiCard } from '@/components/console';
import {
  SEGMENT_LABELS,
  SEGMENT_ORDER,
  segmentZipMatrix,
  type RpcState,
  type SegmentByZipRow,
  type SegmentRow,
} from '@/lib/bidder-insights';

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

export function SegmentsSection({
  segments,
  segmentsByZip,
}: {
  segments: RpcState<SegmentRow>;
  segmentsByZip: RpcState<SegmentByZipRow>;
}) {
  return (
    <section style={{ marginBottom: '2.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Activity segments</h2>
      <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 0.75rem', maxWidth: 820 }}>
        Every registered bidder falls into exactly one segment, evaluated as of right now.{' '}
        <strong>New</strong> takes priority over the bid-recency buckets — a signup from this week counts as New
        even if they already placed a bid.
      </p>

      {segments.kind === 'needs_migration' && (
        <Notice tone="calm">
          This report needs migration 0449 (bidder insights). It will fill in once that migration is applied.
        </Notice>
      )}
      {segments.kind === 'forbidden' && <p style={muted}>Admins or managers only.</p>}
      {segments.kind === 'error' && <Notice tone="danger">Couldn&apos;t load segments: {segments.message}</Notice>}

      {segments.kind === 'ok' && (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          {segments.rows.map((r) => (
            <KpiCard key={r.segment} label={SEGMENT_LABELS[r.segment]} value={String(r.bidders)} />
          ))}
        </section>
      )}

      {segmentsByZip.kind === 'ok' && segmentsByZip.rows.length > 0 && (
        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>ZIP</th>
                {SEGMENT_ORDER.map((k) => (
                  <th key={k} style={{ textAlign: 'right' }}>
                    {SEGMENT_LABELS[k]}
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {segmentZipMatrix(segmentsByZip.rows).map((m) => (
                <tr key={m.postalCode}>
                  <td>{m.postalCode}</td>
                  {SEGMENT_ORDER.map((k) => (
                    <td key={k} style={num}>
                      {m.counts[k]}
                    </td>
                  ))}
                  <td style={{ ...num, fontWeight: 700 }}>{m.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
