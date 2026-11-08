// Weekly signup cohorts section of /reports/bidder-insights: rows = signup
// week, columns = weeks since signup, cell = % of that cohort who bid (and
// won) that calendar week. Last 12 cohorts. Server component. Aggregates
// only — cohort_size is the only count, no bidder identity.

import { buildCohortMatrix, type CohortRow, type RpcState } from '@/lib/bidder-insights';
import { COHORT_WEEKS } from './data';

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

/** Cell background: stronger accent tint for a higher bid %, same idea as a classic retention heat map. */
function cellTone(pct: number): string {
  if (pct <= 0) return 'transparent';
  const alpha = Math.min(0.08 + (pct / 100) * 0.45, 0.5);
  return `rgba(99, 179, 237, ${alpha.toFixed(2)})`;
}

export function CohortSection({ cohorts }: { cohorts: RpcState<CohortRow> }) {
  return (
    <section>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Weekly signup cohorts</h2>
      <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 0.75rem', maxWidth: 820 }}>
        Each row is a signup week; each column is weeks since signup. A cell is the % of that cohort who placed a bid
        that calendar week (bold = also won). Weeks bucket in your warehouse timezone, Monday start. A cohort under 3
        signups is dropped — too small to show without identifying someone.
      </p>

      {cohorts.kind === 'needs_migration' && (
        <Notice tone="calm">
          This report needs migration 0449 (bidder insights). It will fill in once that migration is applied.
        </Notice>
      )}
      {cohorts.kind === 'forbidden' && <p style={muted}>Admins or managers only.</p>}
      {cohorts.kind === 'error' && <Notice tone="danger">Couldn&apos;t load cohorts: {cohorts.message}</Notice>}

      {cohorts.kind === 'ok' &&
        (() => {
          const matrix = buildCohortMatrix(cohorts.rows, COHORT_WEEKS);
          if (matrix.length === 0) {
            return (
              <p style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                No cohort has 3+ signups yet in the last {COHORT_WEEKS} weeks.
              </p>
            );
          }
          return (
            <div className="console-table-card" style={{ overflowX: 'auto' }}>
              <table className="console-table">
                <thead>
                  <tr>
                    <th>Cohort week</th>
                    <th style={{ textAlign: 'right' }}>Size</th>
                    {Array.from({ length: COHORT_WEEKS }, (_, i) => (
                      <th key={i} style={{ textAlign: 'right' }}>
                        W{i}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((row) => (
                    <tr key={row.cohortWeek}>
                      <td style={{ whiteSpace: 'nowrap' }}>{row.cohortWeek}</td>
                      <td style={num}>{row.cohortSize}</td>
                      {row.cells.map((cell, i) => (
                        <td
                          key={i}
                          style={{
                            ...num,
                            background: cell ? cellTone(cell.bidPct) : undefined,
                          }}
                        >
                          {cell == null ? (
                            <span style={{ color: 'var(--fg-dim)' }}>—</span>
                          ) : (
                            <span style={{ fontWeight: cell.winPct > 0 ? 700 : 400 }}>{cell.bidPct.toFixed(0)}%</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
    </section>
  );
}
