// Daily lotting report — workers down, days across, printable.
//
// Owner ask 2026-09-03: "a single day lotting number so we know the
// productivity for that day … or maybe a printable report that shows each
// days numbers."
//
// The 7/30-day columns on the main page are rolling windows, so they cannot
// answer "how did we do today" and they flatten the shape of a week: five
// 80-lot days plus two days off reads identically to seven 57-lot days. This
// page is the shape.
//
// ── DAYS ARE CENTRAL, NOT UTC ───────────────────────────────────────────────
// Every boundary comes from worker_daily_productivity(…, p_tz) — see mig 0347.
// UTC midnight is 7 PM Central in summer, so a UTC day would split an evening
// shift across two columns. Nothing here re-derives a date from a timestamp in
// JS, which is how that mistake gets reintroduced.
//
// Server component, no client JS except the print button: the grid is static
// once rendered, and a table that prints correctly is worth more here than one
// that sorts.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { PageHeader } from '@/components/Form';
import { PrintReportButton } from './PrintReportButton';
import {
  buildDailyReport,
  unshelvedColumnCopy,
  type DailyCell,
} from '@/lib/worker-report-unshelved';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 14;

/** "Mon 1" — short enough for fourteen columns on a portrait page. Built from
 *  the date string the database already resolved in the warehouse timezone;
 *  parsing it as UTC noon keeps the label from sliding a day in the browser's
 *  own zone. */
function dayLabel(iso: string): { dow: string; dom: string; weekend: boolean } {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return {
    dow,
    dom: String(d.getUTCDate()),
    weekend: dow === 'Sat' || dow === 'Sun',
  };
}

export default async function DailyLottingReport({
  searchParams,
}: {
  searchParams?: Promise<{ warehouse?: string; end?: string; days?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  const role = (me as { role?: string } | null)?.role;
  const operatorId = (me as { operator_id?: string } | null)?.operator_id;
  if (role !== 'admin' && role !== 'manager') {
    return (
      <div>
        <PageHeader title="Daily lotting" />
        <p style={{ color: 'var(--fg-muted)' }}>This view is restricted to managers.</p>
      </div>
    );
  }

  const sp = (await searchParams) ?? {};
  const admin = getSupabaseAdmin();

  const { data: whRows } = await admin
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId as string)
    .order('name', { ascending: true });
  const warehouses = (whRows ?? []) as Array<{ id: string; name: string }>;
  // Only honour an id this operator owns, so a hand-edited ?warehouse= cannot
  // read another company's floor.
  const warehouseId =
    sp.warehouse && warehouses.some((w) => w.id === sp.warehouse) ? sp.warehouse : null;

  // A malformed ?end= falls back to today rather than erroring — this is a
  // report, and a bad URL should show something rather than nothing.
  const endParam = sp.end && /^\d{4}-\d{2}-\d{2}$/.test(sp.end) ? sp.end : null;
  const days = Math.min(Math.max(Number(sp.days) || DEFAULT_DAYS, 1), 92);

  // On `supabase`, not `admin` — worker_daily_productivity() scopes itself with
  // current_operator_id(), which is NULL for the service role (no auth.uid()),
  // so through the admin client the whole grid came back empty.
  const { data, error } = await supabase.rpc('worker_daily_productivity', {
    p_end: endParam,
    p_days: days,
    p_warehouse_id: warehouseId,
  });
  if (error) console.error('[daily-lotting] rpc failed', error.message);

  // Rows, totals and the unshelved column are built in one pure helper so the
  // invariant All = every location + Unshelved is unit-tested (mig 0420).
  const { dayList, rows, dayTotals, grandTotal, unshelvedTotal, hasUnshelved } =
    buildDailyReport((data ?? []) as DailyCell[]);
  const unshelvedCopy = unshelvedColumnCopy(warehouseId !== null);
  const activeDays = dayList.filter((d) => (dayTotals.get(d) ?? 0) > 0).length;

  const qs = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { warehouse: warehouseId, end: endParam, days: String(days), ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/dashboard/workers/daily${s ? `?${s}` : ''}`;
  };

  // Page back/forward a whole window at a time.
  const lastDay = dayList[dayList.length - 1] ?? null;
  const firstDay = dayList[0] ?? null;
  const shift = (from: string | null, by: number) => {
    if (!from) return null;
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + by);
    return d.toISOString().slice(0, 10);
  };
  const prevEnd = shift(firstDay, -1);
  const nextEnd = shift(lastDay, days);
  const todayIso = new Date().toISOString().slice(0, 10);
  const atPresent = !endParam;

  return (
    <div>
      {/* Print rules live with the page rather than in a global sheet: this is
          the only screen meant to come out on paper, and a manager pinning it
          up does not want the console chrome or the pager on the sheet. */}
      <style>{`
        @media print {
          nav, aside, header, .no-print { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .daily-report table { font-size: 10pt; }
          .daily-report th, .daily-report td {
            border-color: #999 !important; color: #000 !important;
          }
          .daily-report .weekend { background: #f2f2f2 !important; }
          @page { size: portrait; margin: 12mm; }
        }
      `}</style>

      <PageHeader title="Daily lotting" />

      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: '0.9rem' }}>
        <Link href="/dashboard/workers" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          ← Worker Productivity
        </Link>
        <span style={{ flex: 1 }} />
        {warehouses.length > 1 &&
          [{ id: null as string | null, name: 'All locations' }, ...warehouses].map((w) => {
            const active = (w.id ?? null) === warehouseId;
            return (
              <Link
                key={w.id ?? 'all'}
                href={qs({ warehouse: w.id })}
                style={{
                  fontSize: 13,
                  padding: '0.25rem 0.7rem',
                  borderRadius: 999,
                  textDecoration: 'none',
                  border: '1px solid var(--border)',
                  background: active ? 'var(--accent, #2563eb)' : 'transparent',
                  color: active ? '#fff' : 'var(--fg-muted)',
                }}
              >
                {w.name}
              </Link>
            );
          })}
        <PrintReportButton />
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '0.9rem' }}>
        {prevEnd && (
          <Link href={qs({ end: prevEnd })} style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            ← Earlier
          </Link>
        )}
        {!atPresent && (
          <>
            <Link href={qs({ end: nextEnd })} style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              Later →
            </Link>
            <Link href={qs({ end: null })} style={{ fontSize: 13, color: 'var(--accent, #2563eb)' }}>
              Back to today
            </Link>
          </>
        )}
      </div>

      <div className="daily-report" style={{ overflowX: 'auto' }}>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.6rem' }}>
          {firstDay} to {lastDay}
          {warehouseId ? ` · ${warehouses.find((w) => w.id === warehouseId)?.name}` : ' · all locations'}
          {' · '}
          <strong>{grandTotal.toLocaleString()}</strong> lots over {activeDays} working{' '}
          {activeDays === 1 ? 'day' : 'days'}
          {activeDays > 0 && ` · ${Math.round(grandTotal / activeDays).toLocaleString()}/day average`}
          {hasUnshelved && unshelvedTotal > 0 && (
            warehouseId ? (
              <>
                {' · '}
                <strong>{unshelvedTotal.toLocaleString()}</strong> more unshelved (no location yet,
                not counted here)
              </>
            ) : (
              <>
                {' · '}
                {unshelvedTotal.toLocaleString()} of them unshelved (no location yet)
              </>
            )
          )}
        </p>

        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                Worker
              </th>
              {dayList.map((d) => {
                const { dow, dom, weekend } = dayLabel(d);
                return (
                  <th
                    key={d}
                    className={weekend ? 'weekend' : undefined}
                    style={{
                      textAlign: 'right',
                      padding: '4px 6px',
                      borderBottom: '1px solid var(--border)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      background: weekend ? 'rgba(255,255,255,0.03)' : undefined,
                      // Today is worth finding at a glance on a pinned-up sheet.
                      color: d === todayIso ? 'var(--accent, #2563eb)' : undefined,
                    }}
                  >
                    <div style={{ fontSize: 10, opacity: 0.7 }}>{dow}</div>
                    {dom}
                  </th>
                );
              })}
              <th style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                Total
              </th>
              {hasUnshelved && (
                <th
                  title={unshelvedCopy.title}
                  style={{
                    textAlign: 'right',
                    padding: '4px 8px',
                    borderBottom: '1px solid var(--border)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {unshelvedCopy.header}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td
                  style={{
                    padding: '4px 8px',
                    borderBottom: '1px solid var(--border)',
                    whiteSpace: 'nowrap',
                    opacity: r.active ? 1 : 0.55,
                  }}
                >
                  {r.name}
                  {!r.active && <span style={{ fontSize: 11, opacity: 0.7 }}> (inactive)</span>}
                </td>
                {dayList.map((d) => {
                  const n = r.counts.get(d) ?? 0;
                  const { weekend } = dayLabel(d);
                  return (
                    <td
                      key={d}
                      className={weekend ? 'weekend' : undefined}
                      style={{
                        textAlign: 'right',
                        padding: '4px 6px',
                        borderBottom: '1px solid var(--border)',
                        background: weekend ? 'rgba(255,255,255,0.03)' : undefined,
                        // A zero is printed but dimmed: present so the column
                        // reads as a real day, quiet so the worked days carry
                        // the eye.
                        color: n === 0 ? 'var(--fg-muted)' : undefined,
                        opacity: n === 0 ? 0.45 : 1,
                      }}
                    >
                      {n}
                    </td>
                  );
                })}
                <td
                  style={{
                    textAlign: 'right',
                    padding: '4px 8px',
                    borderBottom: '1px solid var(--border)',
                    fontWeight: 600,
                  }}
                >
                  {r.total.toLocaleString()}
                </td>
                {hasUnshelved && (
                  <td
                    style={{
                      textAlign: 'right',
                      padding: '4px 8px',
                      borderBottom: '1px solid var(--border)',
                      color: 'var(--fg-muted)',
                      opacity: r.unshelved === 0 ? 0.45 : 1,
                    }}
                  >
                    {r.unshelved.toLocaleString()}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ padding: '6px 8px', fontWeight: 600 }}>All workers</td>
              {dayList.map((d) => (
                <td key={d} style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600 }}>
                  {dayTotals.get(d) ?? 0}
                </td>
              ))}
              <td style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700 }}>
                {grandTotal.toLocaleString()}
              </td>
              {hasUnshelved && (
                <td style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600, color: 'var(--fg-muted)' }}>
                  {unshelvedTotal.toLocaleString()}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="no-print" style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: '1rem' }}>
        Days run midnight to midnight Central, so an evening shift stays on its own day. Counts are
        lots credited to the PIN worker clocked in when the item was lotted.
        {hasUnshelved && (
          <>
            {' '}
            Unshelved = drafts not yet put away, so they have no location: they count under All
            locations and under no single location. All locations = every location + Unshelved.
          </>
        )}
      </p>
    </div>
  );
}
