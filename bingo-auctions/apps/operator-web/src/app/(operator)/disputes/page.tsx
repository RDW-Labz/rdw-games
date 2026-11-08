import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { formatInTimeZone, warehouseTimezone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';

// Default operator SLA to respond to a bidder-filed dispute, in hours.
// Matches migration 0122 default. Used when the operator hasn't yet
// published a policy row (shouldn't happen post-onboarding, but the page
// must not blow up if it does).
const DEFAULT_DISPUTE_RESPONSE_HOURS = 72;

// Countdown thresholds, in milliseconds. Anything over the warning
// threshold is muted; under it but positive is warning; under the danger
// threshold but still positive is danger; <= 0 is OVERDUE.
const MUTED_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const DANGER_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6h

type DisputeRow = {
  id: string;
  status: string;
  reason: string;
  created_at: string;
  resolved_at: string | null;
  refund_cents: number;
  lot_id: string;
  invoice_id: string;
  bidder_id: string;
  lots?: { title?: string; warehouses?: { timezone?: string } | { timezone?: string }[] | null } | null;
  bidders?: { email?: string; display_name?: string | null } | null;
  invoices?: { total_cents?: number } | null;
};

export default async function DisputesPage() {
  const supabase = await getSupabaseServer();

  // Resolve the caller's operator so we can pull their SLA. Disputes RLS
  // already scopes the rows; this query is only for the policy lookup.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let disputeResponseHours = DEFAULT_DISPUTE_RESPONSE_HOURS;

  if (user) {
    const { data: staff } = await supabase
      .from('operator_users')
      .select('operator_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const operatorId = (staff as { operator_id?: string } | null)?.operator_id;

    if (operatorId) {
      const { data: policy } = await supabase
        .from('operator_policies')
        .select('dispute_response_hours')
        .eq('operator_id', operatorId)
        .eq('published', true)
        // Standardize on version DESC to match every money-path reader
        // (writePolicyRow now keeps a single published row, but this keeps the
        // tie-break identical everywhere if two ever coexist transiently).
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      const hours = (policy as { dispute_response_hours?: number } | null)
        ?.dispute_response_hours;
      if (typeof hours === 'number' && hours > 0) {
        disputeResponseHours = hours;
      }
    }
  }

  const { data: disputesRaw } = await supabase
    .from('disputes')
    .select(
      'id, status, reason, created_at, resolved_at, refund_cents, lot_id, invoice_id, bidder_id, lots(title, warehouses(timezone)), bidders(email, display_name), invoices(total_cents)',
    )
    .order('created_at', { ascending: false })
    .limit(100);

  const disputes = (disputesRaw ?? []) as unknown as DisputeRow[];
  const now = Date.now();
  const slaMs = disputeResponseHours * 60 * 60 * 1000;

  const deadlineMsFor = (d: DisputeRow) =>
    new Date(d.created_at).getTime() + slaMs;

  const open = disputes
    .filter((d) => d.status === 'open')
    .sort((a, b) => deadlineMsFor(a) - deadlineMsFor(b));
  const closed = disputes.filter((d) => d.status !== 'open');

  const overdueCount = open.filter((d) => deadlineMsFor(d) - now <= 0).length;
  const soonCount = open.filter((d) => {
    const remaining = deadlineMsFor(d) - now;
    return remaining > 0 && remaining < MUTED_THRESHOLD_MS;
  }).length;

  return (
    <div>
      <PageHeader title="Disputes" />

      <SlaBanner overdueCount={overdueCount} soonCount={soonCount} />

      <Section
        title={`Open (${open.length})`}
        disputes={open}
        slaMs={slaMs}
        now={now}
        highlight
      />
      <Section
        title={`Closed (${closed.length})`}
        disputes={closed}
        slaMs={slaMs}
        now={now}
        muted
      />
    </div>
  );
}

function SlaBanner({
  overdueCount,
  soonCount,
}: {
  overdueCount: number;
  soonCount: number;
}) {
  const hasOverdue = overdueCount > 0;
  const bg = hasOverdue ? 'var(--danger)' : 'var(--bg-elev)';
  const fg = hasOverdue ? '#fff' : 'var(--fg-muted)';
  const border = hasOverdue ? 'var(--danger)' : 'var(--border)';

  return (
    <div
      style={{
        padding: '0.75rem 1rem',
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        marginBottom: '1.25rem',
        fontSize: 14,
        fontWeight: hasOverdue ? 600 : 500,
      }}
    >
      {hasOverdue
        ? `${overdueCount} ${overdueCount === 1 ? 'dispute' : 'disputes'} overdue · ${soonCount} due in <24h`
        : 'No disputes overdue'}
    </div>
  );
}

function Section({
  title,
  disputes,
  slaMs,
  now,
  highlight,
  muted,
}: {
  title: string;
  disputes: DisputeRow[];
  slaMs: number;
  now: number;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2
        style={{
          fontSize: '1rem',
          color: muted ? 'var(--fg-muted)' : highlight ? 'var(--accent)' : 'var(--fg)',
          marginBottom: '0.5rem',
        }}
      >
        {title}
      </h2>
      {disputes.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>—</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
          {disputes.map((d) => {
            const isOpen = d.status === 'open';
            const createdMs = new Date(d.created_at).getTime();
            const deadlineMs = createdMs + slaMs;
            const remainingMs = deadlineMs - now;

            return (
              <li
                key={d.id}
                style={{
                  padding: '1rem',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{d.lots?.title ?? 'Lot'}</div>
                  <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>
                    {d.bidders?.display_name ?? d.bidders?.email ?? 'Bidder'} ·{' '}
                    {formatInTimeZone(d.created_at, warehouseTimezone(d.lots?.warehouses))}
                  </div>
                  {isOpen && (
                    <div style={{ marginTop: 6 }}>
                      <CountdownBadge remainingMs={remainingMs} />
                    </div>
                  )}
                  {!isOpen && d.resolved_at && (
                    <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>
                      Resolved {formatResolvedAfter(d.created_at, d.resolved_at)} after filing
                    </div>
                  )}
                  <div
                    style={{
                      color: 'var(--fg)',
                      marginTop: 6,
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {d.reason.slice(0, 120)}
                  </div>
                  {d.refund_cents > 0 && (
                    <div style={{ color: 'var(--success)', fontSize: 13, marginTop: 4 }}>
                      Refunded {formatCents(d.refund_cents)}
                    </div>
                  )}
                </div>
                <Link
                  href={`/disputes/${d.id}`}
                  style={{ flexShrink: 0, color: 'var(--accent)' }}
                >
                  Review →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CountdownBadge({ remainingMs }: { remainingMs: number }) {
  const isOverdue = remainingMs <= 0;
  const abs = Math.abs(remainingMs);
  const hours = Math.floor(abs / (60 * 60 * 1000));
  const days = Math.floor(abs / (24 * 60 * 60 * 1000));

  let label: string;
  let color: string;
  let bg: string | undefined;
  let textColor: string;

  if (isOverdue) {
    // OVERDUE — solid danger background, white text. Use days if >= 24h overdue.
    label = days >= 1 ? `OVERDUE BY ${days}d` : `OVERDUE BY ${Math.max(hours, 1)}h`;
    color = 'var(--danger)';
    bg = 'var(--danger)';
    textColor = '#fff';
  } else if (remainingMs > MUTED_THRESHOLD_MS) {
    // > 24h remaining — muted text "Due in Nd"
    label = `Due in ${days}d`;
    color = 'var(--fg-muted)';
    bg = undefined;
    textColor = 'var(--fg-muted)';
  } else if (remainingMs > DANGER_THRESHOLD_MS) {
    // 6-24h remaining — warning color
    label = `Due in ${Math.max(hours, 1)}h`;
    color = 'var(--warning)';
    bg = undefined;
    textColor = 'var(--warning)';
  } else {
    // 0-6h remaining — danger color (not yet overdue, but imminent)
    label = `Due in ${Math.max(hours, 1)}h`;
    color = 'var(--danger)';
    bg = undefined;
    textColor = 'var(--danger)';
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: isOverdue ? '3px 8px' : '0',
        background: bg,
        color: textColor,
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: isOverdue ? 0.3 : 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isOverdue ? '#fff' : color,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

function formatResolvedAfter(createdAt: string, resolvedAt: string): string {
  const diffMs = new Date(resolvedAt).getTime() - new Date(createdAt).getTime();
  if (diffMs < 0) return '0h';
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return days >= 1 ? `${days}d` : `${Math.max(hours, 1)}h`;
}
