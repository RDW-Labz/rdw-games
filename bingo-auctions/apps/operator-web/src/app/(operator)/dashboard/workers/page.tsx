// Worker productivity view — per-staff metrics for the current operator.
//
// Admin-only: pickers should not see each other's numbers.
//
// Attribution sources (all from existing schema, no new migrations):
//   - imports.created_by  (0020)  → import upload credit per worker
//   - lots.import_row_id → import_rows.import_id → imports (post-0068)
//   - import_rows.dropped_by (0029) → drop count per worker
//   - bin_assignments.operator_user_id (0001) → staging scans per worker
//   - invoice_lots.winning_bid_cents + lots ← import_rows ← import ← created_by → GMV
//
// Intake scans (intake_lot_to_bin RPC) do NOT stamp a user-id on lots —
// lots.intake_at is set but there is no intake_by column. Those cells
// show "—". See punch list at the bottom of the file.
//
// 0068: lots.import_id was dropped; attribution now joins through
// import_rows. Pre-0029 legacy lots (no import_row_id) are
// un-attributable, which matches reality — they predate worker tracking.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { PageHeader } from '@/components/Form';
import { formatCents } from '@auction-platform/shared/money';
import { unshelvedColumnCopy } from '@/lib/worker-report-unshelved';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkerRow {
  userId: string;
  operatorUserId: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'manager' | 'picker' | 'lead';
  // Computable from lots.import_row_id → import_rows.import_id → imports.created_by
  lotsCreated7d: number;
  lotsCreated30d: number;
  // Computable from import_rows.dropped_by
  rowsDropped7d: number;
  // Computable from bin_assignments.operator_user_id
  stagingScans7d: number;
  stagingScans30d: number;
  // Computable via imports attribution → invoice_lots
  gmvCents30d: number | null; // null = not attributable
  // Latest activity timestamp across all attributable events
  lastActiveAt: string | null;
}

// ---------------------------------------------------------------------------
// Data-fetching helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** A warehouse worker (PIN identity, mig 0281) plus their attributed output. */
interface PinWorkerRow {
  workerId: string;
  displayName: string;
  role: string;
  isActive: boolean;
  assignedWarehouse: string | null;
  lotsToday: number;
  lots7d: number;
  lots30d: number;
  /** How many of lots30d were relots the worker physically performed. */
  relots30d: number;
  /** Distinct days with at least one lot in the window. */
  daysWorked: number;
  /** lots30d / daysWorked — strips out how often somebody was rostered. */
  perDay: number | null;
  /** Lots per hour between the first and last lot of each day. See mig 0348. */
  perHour: number | null;
  lastLottedAt: string | null;
  /** Mig 0420: this worker's drafts with no location yet, whatever location is
   *  selected. In the totals under All locations; NOT in a location's totals. */
  unshelvedToday: number;
  unshelved7d: number;
  unshelved30d: number;
}


/** Count lots created per staff worker, keyed by user_id (= lots.lotted_by,
 *  stamped at insert by the mig 0279 trigger = auth.uid() = operator_users.user_id).
 *
 *  Replaces the old lots→import_rows→imports.created_by join, which only credited
 *  CSV-manifest uploads to the manifest uploader and therefore showed 0 for the
 *  field-mobile lotting path BinGo staff actually use (create_draft_lot never set
 *  import_row_id — verified 2026-07-21: all recent lots had import_row_id = NULL).
 *  Lots created before 0279 have lotted_by = NULL and are skipped (no worker to
 *  credit); attribution is exact for everything lotted from here on. */
async function fetchLotsCreatedByWorker(
  admin: ReturnType<typeof getSupabaseAdmin>,
  operatorId: string,
  since: string,
): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from('lots')
    .select('lotted_by')
    .eq('operator_id', operatorId)
    .not('lotted_by', 'is', null)
    .gte('created_at', since);

  if (error || !data) return new Map();

  const counts = new Map<string, number>();
  for (const row of data) {
    const uid = (row as { lotted_by: string | null }).lotted_by;
    if (!uid) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return counts;
}

/** Count import_rows dropped per worker over the window. */
async function fetchDropsByWorker(
  admin: ReturnType<typeof getSupabaseAdmin>,
  operatorId: string,
  since: string,
): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from('import_rows')
    .select('dropped_by')
    .eq('operator_id', operatorId)
    .eq('status', 'dropped')
    .not('dropped_by', 'is', null)
    .gte('dropped_at', since);

  if (error || !data) return new Map();

  const counts = new Map<string, number>();
  for (const row of data) {
    const uid = row.dropped_by as string | null;
    if (!uid) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return counts;
}

/**
 * Count bin_assignments per operator_user_id (staging scans — assigning
 * a won lot to a pickup bin). This tracks post-auction picker activity,
 * NOT intake scans (those have no user attribution in the schema).
 */
async function fetchStagingByWorker(
  admin: ReturnType<typeof getSupabaseAdmin>,
  operatorId: string,
  since: string,
): Promise<Map<string, number>> {
  // bin_assignments.operator_user_id references operator_users.id (NOT user_id).
  // We need to map operator_users.id → user_id. We'll fetch both and join.
  const { data, error } = await admin
    .from('bin_assignments')
    .select('operator_user_id, assigned_at, lots!inner(operator_id)')
    .not('operator_user_id', 'is', null)
    .gte('assigned_at', since);

  if (error || !data) return new Map();

  // Filter to this operator's lots
  const counts = new Map<string, number>();
  for (const row of data) {
    const lots = row.lots as unknown as { operator_id: string } | Array<{ operator_id: string }>;
    const lotOperatorId = Array.isArray(lots) ? lots[0]?.operator_id : lots?.operator_id;
    if (lotOperatorId !== operatorId) continue;
    const ouId = row.operator_user_id as string | null;
    if (!ouId) continue;
    counts.set(ouId, (counts.get(ouId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sum invoice_lots.winning_bid_cents for won lots attributable to each worker
 * via the import chain: invoice_lots → lots → imports → created_by.
 *
 * This is an approximation — it gives credit to whoever uploaded the manifest
 * that sourced the lot. Picker-level GMV attribution doesn't exist in the schema.
 */
async function fetchGmvByWorker(
  admin: ReturnType<typeof getSupabaseAdmin>,
  operatorId: string,
  since: string,
): Promise<Map<string, number>> {
  // Pull won lots with import attribution + winning bid.
  // Path: invoice_lots → lots → import_rows → imports.created_by (post-0068).
  const { data, error } = await admin
    .from('invoice_lots')
    .select(
      'winning_bid_cents, lots!inner(operator_id, import_row_id, import_rows(imports(created_by)))',
    )
    .gte('lots.closed_at', since);

  if (error || !data) return new Map();

  const gmv = new Map<string, number>();
  for (const row of data) {
    const lots = row.lots as unknown as {
      operator_id: string;
      import_row_id: string | null;
      import_rows:
        | { imports: { created_by: string | null } | null }
        | Array<{ imports: { created_by: string | null } | null }>
        | null;
    } | null;
    if (!lots || lots.operator_id !== operatorId) continue;
    const ir = Array.isArray(lots.import_rows) ? lots.import_rows[0] : lots.import_rows;
    const createdBy = ir?.imports?.created_by;
    if (!createdBy) continue;
    const cents = (row.winning_bid_cents as number | null) ?? 0;
    gmv.set(createdBy, (gmv.get(createdBy) ?? 0) + cents);
  }
  return gmv;
}

/**
 * Latest activity timestamp per worker (latest import upload or drop action).
 */
async function fetchLastActiveByWorker(
  admin: ReturnType<typeof getSupabaseAdmin>,
  operatorId: string,
): Promise<Map<string, string>> {
  const { data: importData } = await admin
    .from('imports')
    .select('created_by, created_at')
    .eq('operator_id', operatorId)
    .not('created_by', 'is', null)
    .order('created_at', { ascending: false });

  const { data: dropData } = await admin
    .from('import_rows')
    .select('dropped_by, dropped_at')
    .eq('operator_id', operatorId)
    .eq('status', 'dropped')
    .not('dropped_by', 'is', null)
    .order('dropped_at', { ascending: false });

  const latest = new Map<string, string>();

  for (const row of importData ?? []) {
    const uid = row.created_by as string | null;
    if (!uid) continue;
    const existing = latest.get(uid);
    const ts = row.created_at as string;
    if (!existing || ts > existing) latest.set(uid, ts);
  }
  for (const row of dropData ?? []) {
    const uid = row.dropped_by as string | null;
    if (!uid) continue;
    const existing = latest.get(uid);
    const ts = row.dropped_at as string | null;
    if (!ts) continue;
    if (!existing || ts > existing) latest.set(uid, ts);
  }

  return latest;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function roleBadge(role: WorkerRow['role']): string {
  switch (role) {
    case 'admin': return 'Admin';
    case 'manager': return 'Manager';
    case 'picker': return 'Picker';
    case 'lead': return 'Lead';
  }
}

// ---------------------------------------------------------------------------
// Page (server component)
// ---------------------------------------------------------------------------

export default async function WorkersPage({
  searchParams,
}: {
  searchParams?: Promise<{ warehouse?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Role check — admin only. Managers and pickers must not see this page.
  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  if (me.role !== 'admin') {
    return (
      <div>
        <PageHeader title="Worker Productivity" />
        <p style={{ color: 'var(--fg-muted)' }}>
          This view is restricted to administrators.
        </p>
      </div>
    );
  }

  const operatorId = me.operator_id as string;
  const admin = getSupabaseAdmin();

  const since7d = daysAgo(7);
  const since30d = daysAgo(30);

  // Fetch all staff for this operator
  const { data: staffRows } = await supabase
    .from('operator_users')
    .select('id, user_id, email, display_name, role')
    .eq('operator_id', operatorId)
    .order('role', { ascending: true });

  // ── Location filter ──────────────────────────────────────────────────────
  // Harrison is the only live floor today; Dodge City is training and
  // Springdale is waiting on stock. Reading one location at a time is what
  // makes those two legible before they have volume to hide behind.
  const sp = (await searchParams) ?? {};
  const { data: warehouseRows } = await admin
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId)
    .order('name', { ascending: true });
  const warehouses = (warehouseRows ?? []) as Array<{ id: string; name: string }>;
  // Only honour an id this operator actually owns — a ?warehouse= from
  // anywhere else must not select another operator's location.
  const selectedWarehouseId =
    sp.warehouse && warehouses.some((w) => w.id === sp.warehouse) ? sp.warehouse : null;

  // Warehouse workers (PIN identity) — the people who actually lot items.
  //
  // Counted in SQL by worker_productivity() (mig 0346), NOT by fetching lot
  // rows and counting them here. The previous version did the latter with no
  // .limit(), and PostgREST silently caps a select at 1000 rows: the 30-day
  // column counted an arbitrary 1000 of several thousand lots and came out
  // BELOW the 7-day column for eight of eleven staff. Lane Snow's month read
  // 139 lots against 1,045 actually lotted. There is nothing to truncate when
  // the database returns one row per worker.
  //
  // Called on `supabase` (the signed-in session), NOT on `admin`. Both
  // functions scope themselves with current_operator_id(), which reads
  // auth.uid(); the service-role client has no user, so auth.uid() is NULL,
  // current_operator_id() is NULL, and `w.operator_id = NULL` matches nothing.
  // Through the admin client this table came back empty and the banner read
  // "0% of the last 30 days' lots carry a PIN worker" — no error, just silence,
  // at every location including All. Verified on prod: with no auth context
  // both functions return 0 rows / 0%, while the same query scoped to the
  // operator returns all twelve workers and 1,051 lots for Lane Snow alone.
  const { data: pinRpcRows, error: pinRpcErr } = await supabase.rpc('worker_productivity', {
    p_warehouse_id: selectedWarehouseId,
  });
  if (pinRpcErr) console.error('[worker-productivity] rpc failed', pinRpcErr.message);
  const { data: coverageRows, error: covRpcErr } = await supabase.rpc(
    'worker_productivity_coverage',
    { p_warehouse_id: selectedWarehouseId },
  );
  if (covRpcErr) console.error('[worker-productivity] coverage rpc failed', covRpcErr.message);

  // Fire all attribution queries in parallel
  const [
    lots7dByWorker,
    lots30dByWorker,
    drops7dByWorker,
    staging7dByWorker,
    staging30dByWorker,
    gmv30dByWorker,
    lastActiveByWorker,
  ] = await Promise.all([
    fetchLotsCreatedByWorker(admin, operatorId, since7d),
    fetchLotsCreatedByWorker(admin, operatorId, since30d),
    fetchDropsByWorker(admin, operatorId, since7d),
    fetchStagingByWorker(admin, operatorId, since7d),
    fetchStagingByWorker(admin, operatorId, since30d),
    fetchGmvByWorker(admin, operatorId, since30d),
    fetchLastActiveByWorker(admin, operatorId),
  ]);

  const pinWorkers: PinWorkerRow[] = ((pinRpcRows ?? []) as Array<{
    worker_id: string;
    display_name: string;
    role: string;
    is_active: boolean;
    assigned_warehouse: string | null;
    lots_today: number;
    lots_7d: number;
    lots_30d: number;
    relots_30d: number;
    days_worked_30d: number;
    per_day_30d: number | null;
    per_hour_30d: number | null;
    last_lotted: string | null;
    // 0420+; absent until the migration is applied.
    unshelved_today?: number;
    unshelved_7d?: number;
    unshelved_30d?: number;
  }>).map((w) => ({
    workerId: w.worker_id,
    displayName: w.display_name,
    role: w.role,
    isActive: w.is_active,
    assignedWarehouse: w.assigned_warehouse,
    lotsToday: Number(w.lots_today),
    lots7d: Number(w.lots_7d),
    lots30d: Number(w.lots_30d),
    relots30d: Number(w.relots_30d),
    daysWorked: Number(w.days_worked_30d),
    perDay: w.per_day_30d == null ? null : Number(w.per_day_30d),
    perHour: w.per_hour_30d == null ? null : Number(w.per_hour_30d),
    lastLottedAt: w.last_lotted,
    unshelvedToday: Number(w.unshelved_today ?? 0),
    unshelved7d: Number(w.unshelved_7d ?? 0),
    unshelved30d: Number(w.unshelved_30d ?? 0),
  }));
  // Hide the Unshelved column until 0420 is applied, rather than showing zeros
  // that look like a real answer.
  const hasUnshelved = ((pinRpcRows ?? []) as Array<Record<string, unknown>>).some(
    (r) => 'unshelved_30d' in r,
  );
  const unshelvedCopy = unshelvedColumnCopy(selectedWarehouseId !== null);
  const unshelvedTodayTotal = pinWorkers.reduce((s, w) => s + w.unshelvedToday, 0);
  // Already ordered by the function; no client-side re-sort needed.

  // How much of the window actually carries a PIN worker. Surfaced rather than
  // hidden: the stamp is a best-effort follow-up UPDATE on one create path, so
  // coverage is partial (44% in the first week it ran on prod) and the totals
  // below are only as complete as this number.
  const coverageRow = ((coverageRows ?? []) as Array<{ attributed_pct: number | null }>)[0];
  const coveragePct =
    coverageRow?.attributed_pct != null ? Math.round(Number(coverageRow.attributed_pct)) : null;

  // Assemble per-worker rows
  const workers: WorkerRow[] = (staffRows ?? []).map((s) => {
    const userId = s.user_id as string;
    const ouId = s.id as string;

    return {
      userId,
      operatorUserId: ouId,
      email: s.email as string,
      displayName: s.display_name as string | null,
      role: s.role as WorkerRow['role'],
      lotsCreated7d: lots7dByWorker.get(userId) ?? 0,
      lotsCreated30d: lots30dByWorker.get(userId) ?? 0,
      rowsDropped7d: drops7dByWorker.get(userId) ?? 0,
      stagingScans7d: staging7dByWorker.get(ouId) ?? 0,
      stagingScans30d: staging30dByWorker.get(ouId) ?? 0,
      // GMV is null (show "—") only when this worker has no import-attributed lots at all.
      // If they imported lots but none won yet, show $0 so "—" is unambiguous.
      gmvCents30d: lots30dByWorker.has(userId) ? (gmv30dByWorker.get(userId) ?? 0) : null,
      lastActiveAt: lastActiveByWorker.get(userId) ?? null,
    };
  });

  // Sort by lots-created-30d descending (most productive first)
  workers.sort((a, b) => b.lotsCreated30d - a.lotsCreated30d);

  // Aggregate totals
  const totals = {
    lotsCreated7d: workers.reduce((s, w) => s + w.lotsCreated7d, 0),
    lotsCreated30d: workers.reduce((s, w) => s + w.lotsCreated30d, 0),
    rowsDropped7d: workers.reduce((s, w) => s + w.rowsDropped7d, 0),
    stagingScans7d: workers.reduce((s, w) => s + w.stagingScans7d, 0),
    gmvCents30d: workers.every((w) => w.gmvCents30d === null)
      ? null
      : workers.reduce((s, w) => s + (w.gmvCents30d ?? 0), 0),
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const thStyle: React.CSSProperties = {
    padding: '0.6rem 0.75rem',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: 'var(--fg-muted)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    padding: '0.65rem 0.75rem',
    fontSize: 14,
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
  };

  // Shared by the six numeric columns in the PIN table.
  const numCell: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  };

  const numTdStyle: React.CSSProperties = {
    ...tdStyle,
    fontFamily: 'monospace',
    textAlign: 'right',
  };

  const totalRowStyle: React.CSSProperties = {
    background: 'var(--bg-elev)',
    fontWeight: 600,
  };

  return (
    <div>
      <PageHeader
        title="Worker Productivity"
        action={
          <Link
            href="/dashboard"
            style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
          >
            ← Back to Dashboard
          </Link>
        }
      />

      {/* ── Warehouse workers (PIN) — the people, not the sign-in accounts ──
          This section is first because it answers the question the page is for.
          The account table below still has a job (import uploads and GMV are
          attributed to the email login that did them) but it cannot tell you who
          lotted anything: the field app signs in once per device as a shared
          station account. */}
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Warehouse workers (PIN)</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '0.75rem' }}>
        Every lot an employee created and stickered, by any method — manual, Quick Lot, and relots
        they physically performed. Only the auto-relister&apos;s own output is excluded, where the
        system moves an unsold item back into an auction and nobody handles the box. Sorted by lots
        (30 days); <strong>per hour</strong> is the fairest column, since it does not punish a short
        shift.
      </p>

      {/* Location filter. Plain links, not a <select>, so this stays a server
          component and the choice lives in the URL — shareable, and it survives
          a refresh. Hidden entirely for a single-warehouse operator, where the
          filter would be a control with one meaningful option. */}
      {warehouses.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: '0.9rem',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Location:</span>
          {[{ id: null as string | null, name: 'All locations' }, ...warehouses].map((w) => {
            const active = (w.id ?? null) === selectedWarehouseId;
            return (
              <Link
                key={w.id ?? 'all'}
                href={w.id ? `/dashboard/workers?warehouse=${w.id}` : '/dashboard/workers'}
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
        </div>
      )}

      {hasUnshelved && selectedWarehouseId && unshelvedTodayTotal > 0 && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.9rem', maxWidth: 780 }}>
          <strong>{unshelvedTodayTotal}</strong> of today&apos;s drafts by these workers have no
          location yet (not put away), so they are not in this location&apos;s numbers. They are in
          the <strong>+ Unshelved</strong> column. All locations = every location + Unshelved.
        </p>
      )}

      <p style={{ margin: '0 0 0.9rem' }}>
        <Link
          href={selectedWarehouseId
            ? `/dashboard/workers/daily?warehouse=${selectedWarehouseId}`
            : '/dashboard/workers/daily'}
          style={{ fontSize: 13, color: 'var(--accent, #2563eb)' }}
        >
          Daily lotting report — day by day, printable →
        </Link>
      </p>

      {coveragePct !== null && coveragePct < 95 && (
        <div
          style={{
            padding: '0.6rem 0.9rem',
            border: '1px solid rgba(251,191,36,0.35)',
            background: 'rgba(251,191,36,0.08)',
            borderRadius: 8,
            fontSize: 13,
            marginBottom: '0.9rem',
            maxWidth: 780,
          }}
        >
          <strong>{coveragePct}% of the last 30 days&apos; lots carry a PIN worker.</strong> The
          rest were created with nobody clocked in — from a desk, or on a device where the PIN
          screen was empty. Those are missing from the counts below rather than being credited to
          someone else. Treat these as a floor, not a total.
        </div>
      )}

      <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Worker</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Role</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Today</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Lots 7d</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Lots 30d</th>
              <th
                style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}
                title="How many of the 30-day total were relots this worker physically performed and stickered. Included in the total."
              >
                of which relots
              </th>
              {hasUnshelved && (
                <th
                  style={{ padding: '0.5rem 0.75rem', textAlign: 'right', whiteSpace: 'nowrap' }}
                  title={unshelvedCopy.title}
                >
                  {unshelvedCopy.header}
                  <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--fg-muted)' }}>
                    today / 7d / 30d
                  </div>
                </th>
              )}
              <th
                style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}
                title="Distinct days with at least one lot in the last 30."
              >
                Days
              </th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Per day</th>
              <th
                style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}
                title="Lots divided by the time between the first and last lot of each day. Breaks sit inside that span, so this is a floor. Days under 5 lots are left out of this column only."
              >
                Per hour
              </th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Last lotted</th>
            </tr>
          </thead>
          <tbody>
            {pinWorkers.length === 0 ? (
              <tr>
                <td
                  colSpan={hasUnshelved ? 11 : 10}
                  style={{ padding: '1rem 0.75rem', color: 'var(--fg-muted)' }}
                >
                  No warehouse workers yet. Add them under Staff → Manage warehouse workers.
                </td>
              </tr>
            ) : (
              pinWorkers.map((w) => (
                <tr key={w.workerId} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                    {w.displayName}
                    {!w.isActive && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
                        (inactive)
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--fg-muted)', fontSize: 12 }}>
                    {w.role}
                  </td>
                  <td style={numCell}>{w.lotsToday || '—'}</td>
                  <td style={numCell}>{w.lots7d || '—'}</td>
                  <td style={{ ...numCell, fontWeight: 700 }}>{w.lots30d || '—'}</td>
                  <td style={{ ...numCell, color: 'var(--fg-muted)' }}>{w.relots30d || '—'}</td>
                  {hasUnshelved && (
                    <td style={{ ...numCell, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
                      {w.unshelvedToday + w.unshelved7d + w.unshelved30d === 0
                        ? '—'
                        : `${w.unshelvedToday} / ${w.unshelved7d} / ${w.unshelved30d}`}
                    </td>
                  )}
                  <td style={{ ...numCell, color: 'var(--fg-muted)' }}>
                    {w.daysWorked || '—'}
                  </td>
                  <td style={numCell}>{w.perDay != null ? w.perDay.toFixed(1) : '—'}</td>
                  {/* Per hour is the column that actually ranks people, so it carries the
                      weight — a 30-day total mostly measures how often somebody was rostered. */}
                  <td style={{ ...numCell, fontWeight: 700 }}>
                    {w.perHour != null ? w.perHour.toFixed(1) : '—'}
                  </td>
                  <td
                    style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'right',
                      color: 'var(--fg-muted)',
                      fontSize: 12,
                    }}
                  >
                    {relativeTime(w.lastLottedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Sign-in accounts</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '1.5rem' }}>
        Email logins, not warehouse workers. Import uploads and GMV are attributed here. Lots
        created counts the <em>account</em> the device was signed into — on shared warehouse phones
        that is one station account for everyone, so use the PIN table above to see who lotted what.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>Worker</th>
              <th style={thStyle}>Role</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Lots 7d</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Lots 30d</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Drops 7d</th>
              <th
                style={{ ...thStyle, textAlign: 'right' }}
                title="Post-auction bin staging scans per worker. Intake scans are not attributed — see footnote."
              >
                Staging 7d *
              </th>
              <th
                style={{ ...thStyle, textAlign: 'right' }}
                title="Sum of winning bids on lots sourced from this worker's import uploads (30 days). Not attributable for manually-created lots."
              >
                GMV 30d *
              </th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Last Active</th>
            </tr>
          </thead>
          <tbody>
            {/* Aggregate row */}
            <tr style={totalRowStyle}>
              <td style={tdStyle} colSpan={2}>
                All workers ({workers.length})
              </td>
              <td style={{ ...numTdStyle, fontWeight: 600 }}>{totals.lotsCreated7d}</td>
              <td style={{ ...numTdStyle, fontWeight: 600 }}>{totals.lotsCreated30d}</td>
              <td style={{ ...numTdStyle, fontWeight: 600 }}>{totals.rowsDropped7d}</td>
              <td style={{ ...numTdStyle, fontWeight: 600 }}>{totals.stagingScans7d}</td>
              <td style={{ ...numTdStyle, fontWeight: 600 }}>
                {totals.gmvCents30d !== null ? formatCents(totals.gmvCents30d) : '—'}
              </td>
              <td style={tdStyle} />
            </tr>

            {workers.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...tdStyle, color: 'var(--fg-muted)', textAlign: 'center' }}>
                  No staff members found.
                </td>
              </tr>
            )}

            {workers.map((w) => (
              <tr key={w.userId}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>{w.displayName ?? w.email}</div>
                  {w.displayName && (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{w.email}</div>
                  )}
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: w.role === 'admin'
                        ? 'rgba(var(--accent-rgb, 79,70,229), 0.15)'
                        : w.role === 'manager'
                          ? 'rgba(255,165,0,0.12)'
                          : 'var(--bg-elev)',
                      color: w.role === 'admin'
                        ? 'var(--accent)'
                        : w.role === 'manager'
                          ? 'darkorange'
                          : 'var(--fg-muted)',
                      border: '1px solid transparent',
                    }}
                  >
                    {roleBadge(w.role)}
                  </span>
                </td>
                <td style={numTdStyle}>{w.lotsCreated7d || '—'}</td>
                <td style={numTdStyle}>{w.lotsCreated30d || '—'}</td>
                <td style={numTdStyle}>{w.rowsDropped7d || '—'}</td>
                <td style={numTdStyle}>{w.stagingScans7d || '—'}</td>
                <td style={numTdStyle}>
                  {w.gmvCents30d !== null && w.gmvCents30d > 0
                    ? formatCents(w.gmvCents30d)
                    : '—'}
                </td>
                <td
                  style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-muted)', fontSize: 12 }}
                >
                  {relativeTime(w.lastActiveAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Privacy / attribution footnote */}
      <footer
        style={{
          marginTop: '1.5rem',
          padding: '0.75rem 1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--fg-muted)',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>* Attribution notes</strong>
        <ul style={{ margin: '0.4rem 0 0 1.2rem', padding: 0 }}>
          <li>
            <strong>Lots created</strong> — attributed to the staff member who uploaded the source
            import manifest. Lots created manually without an import are not attributed.
          </li>
          <li>
            <strong>Staging scans</strong> — counts post-auction bin assignments per worker.
            Intake scans (pending_intake → in_inventory) are <em>not</em> attributed: the intake
            action does not record which staff member performed it.
          </li>
          <li>
            <strong>GMV</strong> — sum of winning bids on lots whose source import was uploaded by
            this worker. Lots created manually have no worker attribution for GMV.
          </li>
          <li>
            <strong>Warehouse workers (PIN)</strong> — from <code>lots.lotted_by_worker</code>, the
            worker clocked in when the item was lotted. Relots count when a person performed them;
            <code>lots.relist_origin</code> separates those from the auto-relister&apos;s output. This is the only column that names a
            person; everything else on this page names a sign-in account.
          </li>
          <li>
            <strong>Unshelved</strong> — drafts not yet put away have no location, so they count
            under All locations and under no single location. On a location they are shown beside
            the numbers, not added in: All locations = every location + Unshelved.
          </li>
          <li>
            Activity attribution is best-effort based on database audit columns. Shared warehouse
            devices sign in once per device, so account-level rows below cannot separate pickers —
            that is what the PIN table is for.
          </li>
        </ul>
      </footer>
    </div>
  );
}
