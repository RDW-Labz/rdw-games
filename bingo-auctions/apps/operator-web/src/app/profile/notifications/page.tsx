// /profile/notifications — bidder notification history on web.
//
// Parity target: apps/bidder-app/app/(tabs)/notifications.tsx (S14, Cluster D1).
//
// Data source: notifications_outbox WHERE target_user_id = auth.uid()
// ORDER BY created_at DESC LIMIT 100.
//
// RLS: notifications_outbox_self_read policy (mig 0164:16-18) — SELECT
// allowed for authenticated users when target_user_id = auth.uid(). The
// query here also passes an explicit filter as belt-and-braces (matches the
// index from mig 0006 which keys on (target_user_id, created_at)).
//
// Kind→label/tone map is ported directly from the mobile screen. Any new
// kind added server-side gracefully falls through to title-cased raw kind.
//
// Auth: /profile* is gated by middleware. Server component re-checks
// defensively and redirects unauthenticated visitors to /login.
//
// Nav note: profile/page.tsx is off-limits (in-flight branch conflict).
// Nav link to this page will be added in a follow-up.

import { redirect } from 'next/navigation';
import { OUTBID_HEADLINE, outbidBody, formatCents } from '@auction-platform/shared';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mirrors KIND_LABEL from bidder-app/app/(tabs)/notifications.tsx.
// `outbid` is no longer hand-maintained on both sides — it comes from
// @auction-platform/shared so this list, the app's list, the push, the email
// and the SMS cannot say different things about one event.
const KIND_LABEL: Record<string, string> = {
  outbid: OUTBID_HEADLINE,
  won: 'You won!',
  pickup_ready: 'Pickup ready',
  pickup_confirmed: 'Pickup confirmed',
  dispute_update: 'Dispute update',
  payment_failed: 'Payment failed',
  payment_retry_reminder: 'Payment reminder',
  dispute_opened: 'Dispute opened',
  dispute_evidence_due: 'Evidence due',
  lot_relisted_no_show: 'Lot relisted',
  lot_withdrawn: 'Lot withdrawn',
  lot_reinstated: 'Lot back in the auction',
  saved_search_hit: 'Saved search match',
  pickup_no_show_forfeit: 'Lot forfeited',
  pickup_no_show_refund_pending: 'Refund pending',
};

// Mirrors KIND_TONE from bidder-app/app/(tabs)/notifications.tsx.
type Tone = 'danger' | 'success' | 'warn' | 'info';

const KIND_TONE: Record<string, Tone> = {
  outbid: 'warn',
  won: 'success',
  pickup_ready: 'success',
  pickup_confirmed: 'info',
  dispute_update: 'warn',
  payment_failed: 'danger',
  payment_retry_reminder: 'danger',
  dispute_opened: 'danger',
  dispute_evidence_due: 'danger',
  lot_relisted_no_show: 'warn',
  lot_withdrawn: 'warn',
  lot_reinstated: 'info',
  saved_search_hit: 'info',
  pickup_no_show_forfeit: 'danger',
  pickup_no_show_refund_pending: 'warn',
};

type Payload = {
  lot_id?: string;
  lot_title?: string;
  invoice_id?: string;
  current_bid_cents?: number;
  winning_bid_cents?: number;
  deep_link?: string;
};

interface NotificationRow {
  id: string;
  kind: string;
  payload: Payload;
  created_at: string;
}

function toneAccentVar(tone: Tone): string {
  switch (tone) {
    case 'danger':
      return 'var(--danger)';
    case 'success':
      return 'var(--success)';
    case 'warn':
      return 'var(--warning)';
    case 'info':
    default:
      return 'var(--fg-muted)';
  }
}

function toneAccentBg(tone: Tone): string {
  switch (tone) {
    case 'danger':
      return 'rgba(255, 59, 59, 0.08)';
    case 'success':
      return 'rgba(34, 197, 94, 0.08)';
    case 'warn':
      return 'rgba(255, 190, 0, 0.08)';
    case 'info':
    default:
      return 'var(--bg-elev)';
  }
}

function formatKindFallback(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Mirrors describeBody() from bidder-app/app/(tabs)/notifications.tsx.
function describeBody(row: NotificationRow): string | null {
  const p = row.payload ?? {};
  const lotTitle = typeof p.lot_title === 'string' ? p.lot_title : null;
  switch (row.kind) {
    case 'outbid':
      // Shared copy. The old sentence ("Someone outbid you…") shares the
      // defect the push had: it describes somebody else's action instead of
      // telling the customer their own max is no longer enough.
      return outbidBody({
        // No lotCode: the drains decorate row.payload with lot_code in
        // memory at send time and never write it back, so the STORED payload
        // has none. describeLot degrades to the title alone — the sentence is
        // identical to the push and email, only the parenthetical code is
        // absent, which is what these lists have always shown.
        lotTitle,
        price:
          typeof p.current_bid_cents === 'number'
            ? formatCents(p.current_bid_cents)
            : null,
      });
    case 'won':
      return lotTitle
        ? `You won "${lotTitle}". View your invoice.`
        : 'You won an auction. View your invoice.';
    case 'pickup_ready':
      return 'Your items are staged and ready for pickup.';
    case 'pickup_confirmed':
      return 'Pickup confirmed. Thanks!';
    case 'payment_failed':
      return 'Your card was declined. Update your card and pay to keep your items.';
    case 'payment_retry_reminder':
      return 'You have an unpaid invoice. Pay before it expires.';
    case 'dispute_opened':
      return 'A dispute was opened on your invoice. View details.';
    case 'dispute_evidence_due':
      return 'Evidence is due on a disputed invoice.';
    case 'dispute_update':
      return 'There is an update on your dispute.';
    case 'lot_relisted_no_show':
      return lotTitle
        ? `"${lotTitle}" was relisted because the invoice was not paid in time.`
        : 'A won lot was relisted because the invoice was not paid in time.';
    case 'lot_withdrawn':
      return lotTitle
        ? `"${lotTitle}" was withdrawn from the auction. Your bid is void and you won't be charged.`
        : "A lot you bid on was withdrawn from the auction. You won't be charged.";
    case 'lot_reinstated':
      return lotTitle ? `"${lotTitle}" is back in the auction with your bid.` : 'A lot you bid on is back in the auction.';
    case 'saved_search_hit':
      return lotTitle ? `New lot matching your saved search: "${lotTitle}".` : null;
    case 'pickup_no_show_forfeit':
      return 'Your lot was forfeited due to a no-show pickup.';
    case 'pickup_no_show_refund_pending':
      return 'Your lot was relisted and a refund is pending.';
    default:
      return lotTitle ?? null;
  }
}

// Derive a web href from the row's deep_link or payload fields.
// Mobile uses expo-router push; web uses Next.js Link.
function resolveHref(row: NotificationRow): string | null {
  const p = row.payload ?? {};
  // Prefer the explicit deep_link if present and absolute-path.
  if (p.deep_link && typeof p.deep_link === 'string' && p.deep_link.startsWith('/')) {
    return p.deep_link;
  }
  if (p.invoice_id) return `/profile/invoices/${p.invoice_id}`;
  if (p.lot_id) return `/lot/${p.lot_id}`;
  return null;
}

function formatRelativeServer(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 60 * 1000) return 'Just now';
  if (diffMs < 60 * 60 * 1000) {
    const m = Math.round(diffMs / (60 * 1000));
    return `${m}m ago`;
  }
  if (diffMs < 24 * 60 * 60 * 1000) {
    const h = Math.round(diffMs / (60 * 60 * 1000));
    return `${h}h ago`;
  }
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months === 1) return '1mo ago';
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

export default async function NotificationsPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/notifications');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/notifications');
  }

  // RLS policy notifications_outbox_self_read (mig 0164) allows SELECT
  // where target_user_id = auth.uid(). Belt-and-braces explicit filter
  // also uses the (target_user_id, created_at) index from mig 0006.
  const { data: rows, error } = await supabase
    .from('notifications_outbox')
    .select('id, kind, payload, created_at')
    .eq('target_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <Link
          href="/profile"
          style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
        >
          ← Profile
        </Link>
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            color: 'var(--fg)',
            margin: '0.5rem 0 0.25rem',
          }}
        >
          Notifications
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>
          Your last 100 alerts from the platform.
        </p>
      </div>

      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 59, 59, 0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Could not load notifications: {error.message}
        </div>
      )}

      {!error && (!rows || rows.length === 0) && (
        <div
          style={{
            padding: '3rem 1rem',
            textAlign: 'center',
            color: 'var(--fg-muted)',
          }}
        >
          <p
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              color: 'var(--fg)',
              marginBottom: '0.5rem',
            }}
          >
            No alerts yet
          </p>
          <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 320, margin: '0 auto' }}>
            When you're outbid, win an auction, or have a pickup ready, we'll show it here.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div style={{ display: 'grid', gap: '0.625rem' }}>
          {(rows as unknown as NotificationRow[]).map((row) => {
            const tone: Tone = KIND_TONE[row.kind] ?? 'info';
            const accent = toneAccentVar(tone);
            const bg = toneAccentBg(tone);
            const title = KIND_LABEL[row.kind] ?? formatKindFallback(row.kind);
            const body = describeBody(row);
            const href = resolveHref(row);

            const inner = (
              <div
                style={{
                  padding: '0.875rem 1rem',
                  background: bg,
                  border: `1px solid var(--border)`,
                  borderLeft: `4px solid ${accent}`,
                  borderRadius: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 900,
                      letterSpacing: 0.6,
                      textTransform: 'uppercase',
                      color: accent,
                    }}
                  >
                    {title}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--fg-dim)', flexShrink: 0 }}>
                    {formatRelativeServer(row.created_at)}
                  </span>
                </div>
                {body && (
                  <p
                    style={{
                      fontSize: 14,
                      color: 'var(--fg)',
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {body}
                  </p>
                )}
              </div>
            );

            return href ? (
              <Link key={row.id} href={href} style={{ textDecoration: 'none' }}>
                {inner}
              </Link>
            ) : (
              <div key={row.id}>{inner}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
