import { revealMotion, rowMotion } from '@/components/console-v2/motion';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { Card } from '@/components/console-v2/Card';
import { LotIdentity } from '@/components/console-v2/LotIdentity';
import { SectionHeader } from '@/components/console-v2/SectionHeader';
import { StatusPill } from '@/components/console-v2/StatusPill';

export type ClosingLotRow = {
  id: string;
  title: string;
  lot_code: string | null;
  sticker_code?: string | null;
  display_code?: string | null;
  current_bid_cents: number | null;
  bid_count: number;
  close_at: string | null;
  close_label: string;
  status: string;
};

export type NextToCloseProps = {
  rows: ClosingLotRow[];
  timezoneNote?: string;
  /** Page-enter order (40ms steps, capped — components/console-v2/motion.ts). */
  revealIndex?: number;
};

function lotStatusForPill(status: string): string {
  if (status === 'live' || status === 'scheduled') return status;
  return 'live';
}

export function NextToClose({ rows, timezoneNote, revealIndex = 0 }: NextToCloseProps) {
  const reveal = revealMotion(revealIndex);
  return (
    <div id="next-to-close" className={`console-v2-dashboard-closing ${reveal.className}`} style={reveal.style}>
    <Card>
      <SectionHeader
        title="Next to close"
        stageHue="auction"
        subtitle={
          timezoneNote
            ? `Closing times in each lot's warehouse timezone · ${timezoneNote}`
            : "Closing times in each lot's warehouse timezone"
        }
      />
      {rows.length === 0 ? (
        <p style={{ color: 'var(--console-ink-secondary)', margin: 0 }}>No live or scheduled lots.</p>
      ) : (
        <div className="console-v2-closing-table-wrap">
          <table className="console-v2-closing-table">
            <caption className="console-v2-sr-only">Closing lots</caption>
            <thead>
              <tr>
                <th scope="col">Lot</th>
                <th scope="col">Current bid</th>
                <th scope="col">Bids</th>
                <th scope="col">Closes</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const motion = rowMotion(index);
                return (
                <tr key={row.id} className={motion.className} style={motion.style}>
                  <td>
                    <div className="console-v2-cell-inner">
                      <Link href={`/lots/${row.id}`} className="console-v2-closing-lot-link">
                        <LotIdentity
                          lot={{
                            lot_code: row.lot_code,
                            sticker_code: row.sticker_code,
                            display_code: row.display_code,
                          }}
                          showSignatureRule={false}
                        />
                        <span
                          style={{
                            display: 'block',
                            marginTop: 'var(--console-space-1)',
                            fontSize: 'var(--console-text-sm)',
                            color: 'var(--console-ink-secondary)',
                            fontWeight: 'var(--console-weight-body)',
                          }}
                        >
                          {row.title}
                        </span>
                      </Link>
                    </div>
                  </td>
                  <td>
                    <div className="console-v2-cell-inner console-v2-closing-money">
                      {row.current_bid_cents != null ? formatCents(row.current_bid_cents) : '—'}
                    </div>
                  </td>
                  <td>
                    <div className="console-v2-cell-inner">{row.bid_count}</div>
                  </td>
                  <td>
                    <div className="console-v2-cell-inner">{row.close_label}</div>
                  </td>
                  <td>
                    <div className="console-v2-cell-inner">
                      <StatusPill status={lotStatusForPill(row.status)} />
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
    </div>
  );
}
