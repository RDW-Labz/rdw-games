// Admin Help (#878) read-only subscription/balance totals. Flag off.
// Cookie admin + scoped client only. No service role. No model calls.

export const ADMIN_HELP_FLAG = 'ADMIN_HELP_ENABLED';
export type DbError = { code?: string; message?: string };
export type ReadResult = { data: unknown; error: DbError | null };
type Col = (c: string, v?: string) => Chain;
export type Chain = {
  select: Col;
  eq: Col;
  gte: Col;
  lt: Col;
  limit: (n: number) => Chain;
  maybeSingle: () => Promise<ReadResult>;
  then: Promise<ReadResult>['then'];
};
export type ScopedReadClient = { from: (table: string) => Chain };
export type AdminHelpSession = { operatorId: string; client: ScopedReadClient };
export type Unavailable = { unavailable: true; reason: string };
export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
export type ChicagoRange = { from: Date; to: Date; label: string };

const TZ = 'America/Chicago';
const MAX_ROWS = 5000;
const REVENUE = new Set([
  'handling_fee',
  'bidder_pass',
  'member_pro',
  'ad_subscription',
  'ad_boost',
]);
const STAFF_HEADERS = ['x-bingo-app', 'x-help-mode', 'x-bingo-worker'] as const;
const RETRYABLE = new Set(['08006', '57014', 'PGRST000', '503']);
const ID_KEY = /^(email|phone|display_name|full_name|name|pin|bidder_id|user_id|worker_id)$/i;
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const SYNTHETIC_MODEL_PAYLOAD = {
  kind: 'synthetic_fixture',
  private_data_unapproved: true,
} as const;

export function isAdminHelpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ADMIN_HELP_FLAG] === 'true';
}

export function hasStaffAppHeaders(headers: Headers): boolean {
  const auth = headers.get('authorization');
  if (auth && auth.slice(0, 7).toLowerCase() === 'bearer ') return true;
  return STAFF_HEADERS.some((name) => (headers.get(name) ?? '') !== '');
}

function retryable(error: DbError | null | undefined): boolean {
  if (!error) return false;
  const msg = (error.message ?? '').toLowerCase();
  return RETRYABLE.has(error.code ?? '') || msg.includes('fetch failed');
}

function schemaMissing(error: DbError): boolean {
  const code = error.code ?? '';
  return (
    ['PGRST204', 'PGRST205', '42P01', '42703'].includes(code) ||
    (error.message ?? '').toLowerCase().includes('does not exist')
  );
}

async function once(run: () => PromiseLike<ReadResult>): Promise<ReadResult> {
  const first = await run();
  return first.error && retryable(first.error) ? await run() : first;
}

function parts(date: Date) {
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function wall(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day);
  const off = (d: Date) => {
    const p = parts(d);
    const utc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (utc - d.getTime()) / 60000;
  };
  let ts = guess - off(new Date(guess)) * 60000;
  const next = off(new Date(ts));
  if (next !== off(new Date(guess))) ts = guess - next * 60000;
  return new Date(ts);
}

function shift(year: number, month: number, day: number, n: number) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDay(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const p = new Date(Date.UTC(year, month - 1, day));
  const ok = p.getUTCFullYear() === year && p.getUTCMonth() + 1 === month && p.getUTCDate() === day;
  return ok ? { year, month, day } : null;
}

export function chicagoRange(
  range: string,
  now: Date = new Date(),
  from?: string,
  to?: string,
): ChicagoRange | { error: string } {
  const p = parts(now);
  if (range === 'today') {
    const next = shift(p.year, p.month, p.day, 1);
    return {
      from: wall(p.year, p.month, p.day),
      to: wall(next.year, next.month, next.day),
      label: `today (${ymd(p.year, p.month, p.day)}, Central)`,
    };
  }
  if (range !== 'range') return { error: 'range_invalid' };
  if (!from || !to) return { error: 'range_from_to_required' };
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return { error: 'range_dates_yyyymmdd' };
  const end = shift(b.year, b.month, b.day, 1);
  const bounds = {
    from: wall(a.year, a.month, a.day),
    to: wall(end.year, end.month, end.day),
    label: `${from} to ${to} (Central)`,
  };
  if (bounds.from >= bounds.to) return { error: 'range_empty' };
  const days = (bounds.to.getTime() - bounds.from.getTime()) / 86400000;
  if (days > 366) return { error: 'range_too_long' };
  return bounds;
}

export function stripIdentities<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!ID_KEY.test(key)) out[key] = stripIdentities(nested);
  }
  return out as T;
}

const unavail = (reason: string): Unavailable => ({ unavailable: true, reason });
const rows = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? (data as Record<string, unknown>[]) : [];

function fail(result: ReadResult): { ok: false; error: string } | 'schema_missing' | null {
  if (!result.error) return null;
  if (retryable(result.error)) return { ok: false, error: 'retry_exhausted' };
  if (result.error.code === '42501') return { ok: false, error: 'denied' };
  if (schemaMissing(result.error)) return 'schema_missing';
  return { ok: false, error: 'query_failed' };
}

export async function runAdminHelpTool(
  session: AdminHelpSession,
  tool: string,
  input: { range: string; from?: string; to?: string; now?: Date },
): Promise<ToolResult> {
  const bounds = chicagoRange(input.range, input.now ?? new Date(), input.from, input.to);
  if ('error' in bounds) return { ok: false, error: bounds.error };

  if (tool === 'balances') {
    // 0229: bidder_credits is self-read. Empty must not look like $0 held.
    const probe = await once(() => session.client.from('bidder_credits').select('bucket').limit(1));
    const kind = fail(probe);
    if (kind && kind !== 'schema_missing') return kind;
    const wallet = kind === 'schema_missing' ? 'schema_missing' : 'operator_read_unavailable';
    return {
      ok: true,
      data: stripIdentities({
        range: bounds.label,
        wallet_cash_cents: unavail(wallet),
        store_credit_cents: unavail('operator_read_unavailable'),
      }),
    };
  }
  if (tool !== 'subscriptions') return { ok: false, error: 'unknown_tool' };

  const snapshot = await once(() =>
    session.client
      .from('bidder_subscriptions')
      .select('status, created_at')
      .eq('operator_id', session.operatorId)
      .limit(MAX_ROWS),
  );
  const snapKind = fail(snapshot);
  if (snapKind && snapKind !== 'schema_missing') return snapKind;
  if (snapKind === 'schema_missing') {
    return {
      ok: true,
      data: stripIdentities({
        range: bounds.label,
        by_status: unavail('schema_missing'),
        revenue_by_source_cents: unavail('schema_missing'),
      }),
    };
  }

  const by_status = { none: 0, trialing: 0, active: 0, past_due: 0, canceled: 0 };
  let created_in_range = 0;
  const fromMs = bounds.from.getTime();
  const toMs = bounds.to.getTime();
  for (const row of rows(snapshot.data)) {
    const status = String(row.status ?? '');
    if (status in by_status) by_status[status as keyof typeof by_status] += 1;
    const created = row.created_at ? new Date(String(row.created_at)).getTime() : NaN;
    if (Number.isFinite(created) && created >= fromMs && created < toMs) {
      created_in_range += 1;
    }
  }

  const revenue = await once(() =>
    session.client
      .from('invoices')
      .select('revenue_source, total_cents')
      .eq('operator_id', session.operatorId)
      .gte('paid_at', bounds.from.toISOString())
      .lt('paid_at', bounds.to.toISOString())
      .limit(MAX_ROWS),
  );
  const revKind = fail(revenue);
  if (revKind && revKind !== 'schema_missing') return revKind;
  let revenue_by_source_cents: Record<string, number> | Unavailable;
  if (revKind === 'schema_missing') {
    revenue_by_source_cents = unavail('schema_missing');
  } else {
    const totals: Record<string, number> = {};
    for (const row of rows(revenue.data)) {
      const source = String(row.revenue_source ?? '').trim();
      const cents = Number(row.total_cents ?? 0);
      if (REVENUE.has(source) && Number.isInteger(cents)) {
        totals[source] = (totals[source] ?? 0) + cents;
      }
    }
    revenue_by_source_cents = totals;
  }

  return {
    ok: true,
    data: stripIdentities({
      range: bounds.label,
      by_status,
      created_in_range,
      revenue_by_source_cents,
    }),
  };
}
