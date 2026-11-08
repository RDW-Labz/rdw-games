// KpiCard — the single at-a-glance metric card for the operator console.
//
// Replaces the ad-hoc "big number in a box" markup on the dashboard / auction
// detail / bidder detail screens. One card: label on top (uppercase muted),
// value below (display face, large), optional sub/delta line. Tokens only;
// hover-lift + clickable-accent-border live in `.console-kpi` (globals.css) so
// this stays server-component-safe.
//
// Variants:
//   • default   — standard metric tile.
//   • hero      — larger value, for the one headline number on a screen.
//   • tone      — accent | cyan | warning | danger | success colors the value
//                 (e.g. danger for "Owed", success for "Collected").
// LiveChip is the small "● LIVE" marker for dashboards showing a live auction.

import type { CSSProperties, ReactNode } from 'react';

type Tone = 'default' | 'accent' | 'cyan' | 'warning' | 'danger' | 'success';

const TONE_FG: Record<Tone, string> = {
  default: 'var(--fg)',
  accent: 'var(--accent)',
  cyan: 'var(--cyan-hi)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  success: 'var(--success)',
};

export function KpiCard({
  label,
  value,
  sub,
  tone = 'default',
  hero = false,
  muted = false,
  href,
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  /** Small secondary line under the value (delta, context). */
  sub?: ReactNode;
  tone?: Tone;
  hero?: boolean;
  /** De-emphasize the value (secondary metrics). Ignored when tone is set. */
  muted?: boolean;
  /** Renders the card as a link (gets accent border on hover). */
  href?: string;
  style?: CSSProperties;
}) {
  const valueColor = tone === 'default' && muted ? 'var(--fg-muted)' : TONE_FG[tone];
  const cardStyle: CSSProperties = {
    display: 'block',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius, 10px)',
    padding: hero ? '20px 22px' : '16px 18px',
    textDecoration: 'none',
    color: 'inherit',
    ...style,
  };
  const inner = (
    <>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        className="font-display"
        style={{
          fontSize: hero ? 34 : 26,
          fontWeight: 800,
          lineHeight: 1.05,
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {sub != null && (
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 6 }}>{sub}</div>
      )}
    </>
  );
  if (href) {
    return (
      <a href={href} className="console-kpi" style={cardStyle}>
        {inner}
      </a>
    );
  }
  return (
    <div className="console-kpi" style={cardStyle}>
      {inner}
    </div>
  );
}

export function LiveChip({ label = 'Live' }: { label?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: 'var(--accent-dim)',
        color: 'var(--accent)',
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
      }}
    >
      <span
        className="console-live-dot"
        style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
