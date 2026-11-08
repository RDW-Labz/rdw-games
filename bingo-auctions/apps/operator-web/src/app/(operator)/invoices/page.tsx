// /invoices — operator invoice list with aging-aware filtering.
//
// Why this page is shaped this way (L0 launch blocker #1):
//   The original flat table sorted by created_at DESC made it impossible
//   for an operator to find won-but-unpaid bidders before the grace
//   window expires. That is direct revenue leakage, so this view now
//   defaults to "All" but surfaces an Overdue tab + inline row highlight
//   so aged unpaid invoices cannot be missed regardless of which filter
//   the operator is on.
//
// Overdue definition:
//   The DB schema (migration 0001) does NOT have invoices.due_at, so
//   "overdue" is derived as:
//     status = 'pending' AND created_at < now() - OVERDUE_GRACE_DAYS days
//   OVERDUE_GRACE_DAYS = 3 = the migration-0088 default payment_window
//   (24h) + 2 days of operator grace. Tweak the constant if the policy
//   default ever changes.
//
// Invoice status enum (combined from 0001 + 0077 + 0104):
//   pending, paid, refunded, partially_refunded, canceled,
//   unpaid_no_show, payment_failed_grace, payment_failed_relisted

import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatInTimeZone, warehouseTimezone } from '@/lib/datetime';
import {
  parseInvoiceSearch,
  resolveInvoiceSearch,
  scopeOrFilter,
} from '@/lib/invoice-search';
import { PageHeader } from '@/components/Form';
import { DataTable, MoneyText, type Column } from '@/components/console';

const PAGE_SIZE = 50;

// 24h payment window (migration 0088 operator_policies default) + 2d
// operator grace. Surfaced as a named constant so the operator-policy
// work that adds per-tenant payment windows in Phase 2 can swap this
// out without touching the page layout.
const OVERDUE_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FilterKey = 'all' | 'unpaid' | 'open' | 'overdue' | 'paid' | 'failed';

const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All',
  unpaid: 'Unpaid',
  open: 'Open',
  overdue: 'Overdue',
  paid: 'Paid',
  failed: 'Failed',
};

// Everything that still owes money — the actionable "go collect this" set.
// WHY (2026-07-08 recap): the "Open" tab filtered status='pending' only, so a
// declined invoice sitting in payment_failed_grace was invisible here and only
// showed under "Failed" (which reads as done/refunded). Staff couldn't find
// unpaid customers. This bucket surfaces every owed state.
const OWED_STATUSES = [
  'pending',
  'payment_failed_grace',
  'payment_failed_relisted',
  'unpaid_no_show',
] as const;

// Failed bucket groups every non-recoverable / payment-broken state so
// the operator has one tab to triage them. Refunded/canceled live here
// rather than in their own pills because they're rare enough that a
// dedicated tab would be mostly empty.
const FAILED_STATUSES = [
  'unpaid_no_show',
  'payment_failed_grace',
  'payment_failed_relisted',
  'canceled',
  'refunded',
  'partially_refunded',
] as const;

// Human-readable labels for every invoice status value in the DB.
// Shared by the list page (pill text) and the detail page (Stat card).
export const INVOICE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending payment',
  paid: 'Paid',
  payment_failed_grace: 'Payment failed (grace period)',
  payment_failed_relisted: 'Payment failed (relisted)',
  void: 'Voided',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  disputed: 'Disputed',
  unpaid_no_show: 'Unpaid (no-show)',
  canceled: 'Canceled',
};

/** Return the display label for a status string, falling back to the raw value. */
export function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABELS[status] ?? status;
}

function parseFilter(raw: string | string[] | undefined): FilterKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'unpaid' || v === 'open' || v === 'overdue' || v === 'paid' || v === 'failed') return v;
  return 'all';
}

function parsePage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function invoicesHref(filter: FilterKey, q: string, page?: number): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('status', filter);
  if (q) params.set('q', q);
  if (page && page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/invoices?${qs}` : '/invoices';
}

function daysOverdue(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / MS_PER_DAY));
}

function isOverdueRow(status: string, createdAt: string): boolean {
  return status === 'pending' && daysOverdue(createdAt) >= OVERDUE_GRACE_DAYS;
}

// Status pill colors mirror the dashboard palette so operators don't have
// to relearn the color language between pages.
function statusColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'paid':
      return { bg: 'var(--success-dim)', fg: 'var(--success)' };
    case 'pending':
      return { bg: 'var(--warning-dim)', fg: 'var(--warning)' };
    case 'refunded':
    case 'partially_refunded':
      return { bg: 'var(--accent-dim)', fg: 'var(--accent)' };
    case 'unpaid_no_show':
    case 'payment_failed_grace':
    case 'payment_failed_relisted':
      return { bg: 'var(--urgent-red-dim)', fg: 'var(--danger)' };
    case 'canceled':
    default:
      return { bg: 'var(--bg-elev)', fg: 'var(--fg-muted)' };
  }
}

export default async function InvoicesPage(props: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const sp = await props.searchParams;
  const filter = parseFilter(sp.status);
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? '';
  const page = parsePage(sp.page);

  const searchActive = q.length > 0;
  let scopeOr: string | null = null;
  let tooManyBidders = false;
  let searchEmpty = false;

  if (searchActive) {
    const parsed = parseInvoiceSearch(q);
    const scope = await resolveInvoiceSearch(supabase, getSupabaseAdmin(), parsed);
    tooManyBidders = scope.tooManyBidders;
    searchEmpty = scope.empty;
    scopeOr = scope.empty ? null : scopeOrFilter(scope);
  }

  // Overdue threshold expressed as an ISO timestamp so it can be sent
  // straight to PostgREST without round-tripping through SQL.
  const overdueCutoffIso = new Date(Date.now() - OVERDUE_GRACE_DAYS * MS_PER_DAY).toISOString();

  const applySearch = <T extends { or: (f: string) => T }>(query: T): T =>
    scopeOr ? query.or(scopeOr) : query;

  // 5 count queries in parallel + 1 list query. The count queries use
  // head=true so the server only returns the row count, not the rows
  // (~10ms each on a warm cache). The pattern mirrors the lotting
  // overview page (lines 53-96) which is the canonical reference.
  const countBase = () => {
    const c = supabase.from('invoices').select('id', { count: 'exact', head: true });
    return scopeOr ? c.or(scopeOr) : c;
  };

  // Sort overdue ASC (oldest-first → most-overdue rises to the top);
  // every other filter keeps the conventional newest-first.
  const sortAscending = filter === 'overdue';

  const listQuery = (() => {
    let listQ = supabase
      .from('invoices')
      .select(
        'id, status, total_cents, paid_at, created_at, bidder_id, auction_id, auctions(title, warehouses(timezone))',
        { count: 'exact' },
      );

    if (filter === 'unpaid') {
      listQ = listQ.in('status', OWED_STATUSES as unknown as string[]);
    } else if (filter === 'open') {
      listQ = listQ.eq('status', 'pending');
    } else if (filter === 'overdue') {
      listQ = listQ.eq('status', 'pending').lt('created_at', overdueCutoffIso);
    } else if (filter === 'paid') {
      listQ = listQ.eq('status', 'paid');
    } else if (filter === 'failed') {
      listQ = listQ.in('status', FAILED_STATUSES as unknown as string[]);
    }

    listQ = applySearch(listQ);
    return listQ
      .order('created_at', { ascending: sortAscending })
      // Tie-breaker so paging never repeats or skips invoices created together.
      .order('id', { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  })();

  let allCount = 0;
  let unpaidCount = 0;
  let openCount = 0;
  let overdueCount = 0;
  let paidCount = 0;
  let failedCount = 0;
  let invoices: InvoiceRow[] | null = [];
  if (searchActive && searchEmpty) {
    invoices = [];
  } else {
    const [
      { count: allC },
      { count: unpaidC },
      { count: openC },
      { count: overdueC },
      { count: paidC },
      { count: failedC },
      { data: listData },
    ] = await Promise.all([
      countBase(),
      countBase().in('status', OWED_STATUSES as unknown as string[]),
      countBase().eq('status', 'pending'),
      countBase().eq('status', 'pending').lt('created_at', overdueCutoffIso),
      countBase().eq('status', 'paid'),
      countBase().in('status', FAILED_STATUSES as unknown as string[]),
      listQuery,
    ]);
    allCount = allC ?? 0;
    unpaidCount = unpaidC ?? 0;
    openCount = openC ?? 0;
    overdueCount = overdueC ?? 0;
    paidCount = paidC ?? 0;
    failedCount = failedC ?? 0;
    invoices = (listData ?? []) as unknown as InvoiceRow[];
  }

  const counts: Record<FilterKey, number> = {
    all: allCount,
    unpaid: unpaidCount,
    open: openCount,
    overdue: overdueCount,
    paid: paidCount,
    failed: failedCount,
  };

  // Customer name/contact via service role. The invoices `bidders(...)` embed
  // above goes through RLS, and `bidders` has NO operator-staff SELECT policy
  // (only bidders_self_read), so the embed came back null for staff — every
  // row showed "—" with no email/phone (owner report 2026-07-08). Staff
  // identity is verified by the layout; fetch the display fields directly.
  const bidderIds = Array.from(
    new Set((invoices ?? []).map((i) => i.bidder_id as string).filter(Boolean)),
  );
  const { data: bidderRows } = bidderIds.length
    ? await getSupabaseAdmin().from('bidders').select('id, display_name, email, phone').in('id', bidderIds)
    : { data: [] as { id: string; display_name: string | null; email: string | null; phone: string | null }[] };
  const bidderById = new Map(
    ((bidderRows ?? []) as { id: string; display_name: string | null; email: string | null; phone: string | null }[]).map(
      (r) => [r.id, r],
    ),
  );

  const rows = invoices ?? [];
  const shownCount = invoices?.length ?? 0;
  const totalForActiveFilter = counts[filter];
  const rangeStart = totalForActiveFilter === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = totalForActiveFilter === 0 ? 0 : rangeStart + shownCount - 1;
  const pageCount = Math.max(1, Math.ceil(totalForActiveFilter / PAGE_SIZE));
  const prevLabel = filter === 'overdue' ? 'Previous' : 'Newer';
  const nextLabel = filter === 'overdue' ? 'Next' : 'Older';

  const emptyMessage = (() => {
    if (shownCount > 0) return null;
    if (searchActive) return `No invoices match “${q}”.`;
    switch (filter) {
      case 'overdue':
        return 'No overdue invoices — great!';
      case 'open':
        return 'No open invoices.';
      case 'paid':
        return 'No paid invoices yet.';
      case 'failed':
        return 'No failed or refunded invoices.';
      case 'all':
      default:
        return "No invoices yet. They're generated automatically after lots close.";
    }
  })();

  return (
    <div>
      <PageHeader title="Invoices" />

      <form
        action="/invoices"
        method="get"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}
      >
        <input
          name="q"
          defaultValue={q}
          placeholder="Search invoice ID, name, email, phone, bidder #, lot code (e.g. GRA4123327)"
          style={{
            flex: '1 1 280px',
            minWidth: 200,
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--fg)',
          }}
        />
        {filter !== 'all' ? <input type="hidden" name="status" value={filter} /> : null}
        <button
          type="submit"
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Search
        </button>
        {q ? (
          <Link href={invoicesHref(filter, '')} style={{ fontSize: 13, color: 'var(--accent)' }}>
            Clear
          </Link>
        ) : null}
      </form>

      {tooManyBidders ? (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-muted)' }}>
          Many customers match — showing invoices for the first 100. Add more of the name, email or phone
          to narrow it.
        </p>
      ) : null}

      {/* Filter pill row — server-rendered Links so this stays a server
          component. flex-wrap keeps mobile happy (the table itself
          scrolls horizontally, but the controls should stack). */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
          <FilterPill
            key={key}
            label={FILTER_LABELS[key]}
            count={counts[key]}
            href={invoicesHref(key, q)}
            active={filter === key}
            danger={key === 'overdue' && counts[key] > 0}
          />
        ))}
      </div>

      <DataTable
        columns={invoiceColumns(bidderById)}
        rows={rows}
        rowKey={(inv) => inv.id}
        // Row-level overdue treatment: a left border in --danger PLUS the
        // inline badge (in the Status cell) so the cue survives even when the
        // operator is scrolled past the row's left edge on a narrow screen.
        rowStyle={(inv) =>
          isOverdueRow(inv.status, inv.created_at)
            ? { borderLeft: '3px solid var(--danger)' }
            : undefined
        }
        empty={
          searchActive && shownCount === 0
            ? (
                <span>
                  {emptyMessage}{' '}
                  <Link href={invoicesHref(filter, '')} style={{ color: 'var(--accent)' }}>
                    Clear search
                  </Link>
                </span>
              )
            : emptyMessage
        }
      />

      {totalForActiveFilter > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 16,
            fontSize: 13,
            color: 'var(--fg-muted)',
          }}
        >
          <span>
            Showing {rangeStart}–{rangeEnd} of {totalForActiveFilter}
          </span>
          <div style={{ display: 'flex', gap: 12 }}>
            {page > 1 ? (
              <Link href={invoicesHref(filter, q, page - 1)} style={{ color: 'var(--accent)' }}>
                ← {prevLabel}
              </Link>
            ) : null}
            {page < pageCount ? (
              <Link href={invoicesHref(filter, q, page + 1)} style={{ color: 'var(--accent)' }}>
                {nextLabel} →
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Row shape for the invoices list table. `auctions` is the embedded relation
// used for the context title + per-row timezone.
type InvoiceRow = {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
  bidder_id: string;
  auctions?: { title?: string; warehouses?: unknown } | null;
};

type BidderLite = { id: string; display_name: string | null; email: string | null; phone: string | null };

function invoiceColumns(bidderById: Map<string, BidderLite>): Column<InvoiceRow>[] {
  return [
    {
      key: 'created',
      header: 'Created',
      cell: (inv) => formatInTimeZone(inv.created_at, warehouseTimezone(inv.auctions?.warehouses)),
    },
    {
      key: 'invoice',
      header: 'Invoice',
      // Owner report 2026-07-08: clicking the row sent you to the WHOLE
      // auction, not the one invoice you're chasing. The Invoice cell opens
      // THIS invoice; the auction name is context, not the click target.
      cell: (inv) => (
        <>
          <Link href={`/invoices/${inv.id}`} style={{ fontWeight: 600 }}>
            View invoice →
          </Link>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{inv.auctions?.title ?? '—'}</div>
        </>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      // Customer name opens the full customer page; email + phone are inline
      // for immediate outreach on unpaid invoices.
      cell: (inv) => {
        const b = bidderById.get(inv.bidder_id);
        return (
          <>
            <Link href={`/bidders/${inv.bidder_id}`} style={{ fontWeight: 600 }}>
              {b?.display_name ?? b?.email ?? '—'}
            </Link>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {b?.email ?? ''}
              {b?.phone ? ` · ${b.phone}` : ''}
            </div>
          </>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (inv) => <MoneyText cents={inv.total_cents} />,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (inv) => {
        const overdue = isOverdueRow(inv.status, inv.created_at);
        const ageDays = overdue ? daysOverdue(inv.created_at) : 0;
        const pill = statusColor(inv.status);
        return (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Link
              href={`/invoices/${inv.id}`}
              style={{
                background: pill.bg,
                color: pill.fg,
                padding: '2px 8px',
                borderRadius: 4,
                textDecoration: 'none',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.3,
              }}
            >
              {invoiceStatusLabel(inv.status)}
            </Link>
            {overdue && (
              <span
                style={{
                  background: 'var(--urgent-red-dim)',
                  color: 'var(--danger)',
                  padding: '2px 6px',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                OVERDUE {ageDays}d
              </span>
            )}
          </div>
        );
      },
    },
  ];
}

function FilterPill({
  label,
  count,
  href,
  active,
  danger,
}: {
  label: string;
  count: number;
  href: string;
  active: boolean;
  danger: boolean;
}) {
  // The "Overdue" pill gets a red tint whenever the count > 0, even when
  // it's not the active tab. That's the whole point of this surface —
  // overdue revenue should be visible from any view.
  const background = active
    ? danger
      ? 'rgba(255, 59, 59, 0.18)'
      : 'var(--accent-dim)'
    : danger
      ? 'rgba(255, 59, 59, 0.08)'
      : 'var(--bg-elev)';
  const color = active
    ? danger
      ? 'var(--danger)'
      : 'var(--accent)'
    : danger
      ? 'var(--danger)'
      : 'var(--fg)';
  const border = active
    ? danger
      ? '1px solid var(--danger)'
      : '1px solid var(--accent)'
    : '1px solid var(--border)';

  return (
    <Link
      href={href}
      style={{
        padding: '6px 12px',
        background,
        color,
        border,
        borderRadius: 999,
        textDecoration: 'none',
        fontSize: 12,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      <span>{label}</span>
      <span style={{ opacity: 0.75, fontWeight: 600 }}>({count})</span>
    </Link>
  );
}
