// Per-day money table — the one place the console renders revenue by day.
// Columns and their definitions come from MONEY_DAY_COLUMNS (lib/money-daily)
// so every page labels Gross charged / Refunds / Net collected / Tax / Net
// revenue identically. Server component; inline styles match the report pages.

import type { ReactNode } from 'react';
import { formatCents } from '@auction-platform/shared/money';
import { MONEY_DAY_COLUMNS, type MoneyDay, type MoneyDaily } from '@/lib/money-daily';

const th = (alignLeft: boolean) =>
  ({
    padding: '0.4rem 0.5rem',
    borderBottom: '1px solid var(--border)',
    textAlign: alignLeft ? 'left' : 'right',
    color: 'var(--fg-muted)',
    fontSize: 12,
    whiteSpace: 'nowrap',
  }) as const;

const td = (alignLeft: boolean, strong = false) =>
  ({
    padding: '0.35rem 0.5rem',
    textAlign: alignLeft ? 'left' : 'right',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    fontWeight: strong ? 600 : undefined,
  }) as const;

export function formatMoneyDay(day: string): string {
  // Noon avoids any zone shifting the calendar date.
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function MoneyDailyTable({
  money,
  newestFirst = true,
  extraColumns = [],
  showTotals = true,
}: {
  money: MoneyDaily;
  newestFirst?: boolean;
  /** Non-money columns shown between Day and the money columns (e.g. signups). */
  extraColumns?: ReadonlyArray<{ label: string; render: (day: string) => ReactNode }>;
  showTotals?: boolean;
}) {
  const rows: MoneyDay[] = newestFirst ? [...money.days].reverse() : money.days;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={th(true)}>Day</th>
          {extraColumns.map((c) => (
            <th key={c.label} style={th(false)}>
              {c.label}
            </th>
          ))}
          {MONEY_DAY_COLUMNS.map((c) => (
            <th key={c.key} style={th(false)} title={c.title}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.day}>
            <td style={td(true)}>{formatMoneyDay(d.day)}</td>
            {extraColumns.map((c) => (
              <td key={c.label} style={td(false)}>
                {c.render(d.day)}
              </td>
            ))}
            {MONEY_DAY_COLUMNS.map((c) => (
              <td key={c.key} style={td(false, c.key === 'net_revenue_cents')}>
                {formatCents(d[c.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {showTotals && (
        <tfoot>
          <tr style={{ borderTop: '1px solid var(--border)' }}>
            <td style={td(true, true)}>Total</td>
            {extraColumns.map((c) => (
              <td key={c.label} style={td(false)} />
            ))}
            {MONEY_DAY_COLUMNS.map((c) => (
              <td key={c.key} style={td(false, true)}>
                {formatCents(money.totals[c.key])}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

/** One-line legend under a money table: what each column means. */
export function MoneyDailyLegend({ timeZone }: { timeZone: string }) {
  return (
    <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>
      Days are calendar days in {timeZone}. Gross charged = invoice totals incl. tax, on the day the
      card was charged. Refunds = money returned (cash + store credit), on the day the refund was
      issued — so a day can go negative. Net collected = gross − refunds. Tax = sales tax charged
      − tax refunded (owed to the state). Net revenue = winning bids + buyer&apos;s premium −
      refunds, excluding tax.
    </p>
  );
}
