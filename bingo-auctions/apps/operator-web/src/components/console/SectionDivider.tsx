// SectionDivider — the single section break for the operator console.
//
// Replaces stray <hr> / bespoke margin+border divs used to separate blocks on
// long screens (auction detail, bidder detail, settings). Two variants:
//   • quiet  (default) — flat hairline in --border, optional label.
//   • urgent           — orange gradient rule (`.console-rule-urgent`) for the
//                        "needs attention" band (unpaid, disputes, no-shows).
// Optional `title` renders an uppercase-muted section heading with the rule.

import type { CSSProperties, ReactNode } from 'react';

export function SectionDivider({
  title,
  action,
  urgent = false,
  style,
}: {
  /** Optional section heading rendered above/with the rule. */
  title?: ReactNode;
  /** Optional right-aligned control (e.g. a "View all" link). */
  action?: ReactNode;
  urgent?: boolean;
  style?: CSSProperties;
}) {
  if (!title && !action) {
    return urgent ? (
      <hr className="console-rule-urgent" style={{ margin: '20px 0', ...style }} />
    ) : (
      <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid var(--border)', ...style }} />
    );
  }
  return (
    <div style={{ margin: '24px 0 12px', ...style }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
        }}
      >
        {title != null && (
          <h3
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              color: urgent ? 'var(--accent)' : 'var(--fg-muted)',
            }}
          >
            {title}
          </h3>
        )}
        {action}
      </div>
      {urgent ? (
        <hr className="console-rule-urgent" style={{ margin: 0 }} />
      ) : (
        <hr style={{ margin: 0, border: 0, borderTop: '1px solid var(--border)' }} />
      )}
    </div>
  );
}
