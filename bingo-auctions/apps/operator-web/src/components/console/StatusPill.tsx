// StatusPill — the single semantic status chip for the operator console.
//
// Replaces the per-page pill implementations that hardcoded off-token hexes
// (auctions/page.tsx #232839/#7ab8ff/#34d39a/#ffb87a; bidders Pill
// #22c55e/#f0b428/#ff5470; invoices statusColor). One map, tokens only, so
// color language is identical on every screen and future drift is impossible.
//
// Color contract (globals.css tokens):
//   ORANGE  --accent   act now / LIVE
//   CYAN    --cyan     navigate / info (upcoming, informational finals)
//   AMBER   --warning  waiting on someone (pending)
//   RED     --danger   money / trust at risk (failed, no-show, canceled)
//   GREEN   --success  resolved / done (paid, picked up, confirmed)
//   NEUTRAL --fg-dim   inert (draft, closed)

import type { CSSProperties } from 'react';

type Tone = 'accent' | 'cyan' | 'warning' | 'danger' | 'success' | 'neutral';

const TONE: Record<Tone, { bg: string; fg: string }> = {
  accent: { bg: 'var(--accent-dim)', fg: 'var(--accent)' },
  cyan: { bg: 'var(--cyan-dim)', fg: 'var(--cyan-hi)' },
  warning: { bg: 'var(--warning-dim)', fg: 'var(--warning)' },
  danger: { bg: 'var(--urgent-red-dim)', fg: 'var(--danger)' },
  success: { bg: 'var(--success-dim)', fg: 'var(--success)' },
  neutral: { bg: 'var(--bg-elev-2)', fg: 'var(--fg-dim)' },
};

// Semantic status → tone + display label + whether it gets a live dot.
// Keys are the raw DB status strings used across auctions/invoices/lots/
// disputes/bidders. Unknown statuses fall back to neutral + titleized label.
const MAP: Record<string, { tone: Tone; label: string; live?: boolean }> = {
  // ── Auction / lot lifecycle ──
  draft: { tone: 'neutral', label: 'Draft' },
  scheduled: { tone: 'cyan', label: 'Scheduled' },
  live: { tone: 'accent', label: 'Live', live: true },
  in_inventory: { tone: 'cyan', label: 'In inventory' },
  not_put_away: { tone: 'warning', label: 'Not put away' },
  pending_intake: { tone: 'warning', label: 'Pending intake' },
  // ── Manifest-row lifecycle (imports pool) ──
  lotted: { tone: 'success', label: 'Lotted' },
  dropped: { tone: 'neutral', label: 'Dropped' },
  closed: { tone: 'neutral', label: 'Closed' },
  unsold: { tone: 'neutral', label: 'Unsold' },
  sold: { tone: 'success', label: 'Sold' },
  won: { tone: 'success', label: 'Won' },
  relisted: { tone: 'cyan', label: 'Relisted' },
  disposed: { tone: 'neutral', label: 'Disposed' },
  canceled: { tone: 'danger', label: 'Canceled' },
  cancelled: { tone: 'danger', label: 'Canceled' },
  // ── Invoice / ledger ──
  paid: { tone: 'success', label: 'Paid' },
  pending: { tone: 'warning', label: 'Pending' },
  processing: { tone: 'warning', label: 'Processing' },
  payment_failed_grace: { tone: 'danger', label: 'Payment failed' },
  payment_failed_relisted: { tone: 'danger', label: 'Failed · relisted' },
  unpaid_no_show: { tone: 'danger', label: 'No-show' },
  refunded: { tone: 'cyan', label: 'Refunded' },
  partially_refunded: { tone: 'cyan', label: 'Partially refunded' },
  // ── Pickup ──
  checked_in: { tone: 'accent', label: 'Checked in' },
  picked_up: { tone: 'success', label: 'Picked up' },
  completed: { tone: 'success', label: 'Completed' },
  no_show: { tone: 'danger', label: 'No-show' },
  // ── Disputes ──
  open: { tone: 'warning', label: 'Open' },
  resolved: { tone: 'success', label: 'Resolved' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  // ── Settlements (operator ledger) ──
  held: { tone: 'cyan', label: 'Held' },
  releasable: { tone: 'warning', label: 'Releasable' },
  transferred: { tone: 'success', label: 'Transferred' },
  voided: { tone: 'neutral', label: 'Voided' },
};

function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusTone(status: string): Tone {
  return MAP[status]?.tone ?? 'neutral';
}

export function StatusPill({
  status,
  label,
  style,
}: {
  status: string;
  /** Override the auto label. */
  label?: string;
  style?: CSSProperties;
}) {
  const entry = MAP[status];
  const tone = TONE[entry?.tone ?? 'neutral'];
  const text = label ?? entry?.label ?? titleize(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {entry?.live && (
        <span
          className="console-live-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: 'var(--accent)',
            display: 'inline-block',
          }}
          aria-hidden="true"
        />
      )}
      {text}
    </span>
  );
}
