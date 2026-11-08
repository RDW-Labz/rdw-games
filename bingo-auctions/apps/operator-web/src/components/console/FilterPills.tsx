// FilterPills — the single segmented filter control for the operator console.
//
// Replaces the per-page filter-tab implementations (inventory status tabs,
// auctions state tabs, bidders segment) that each rolled their own active/
// inactive styling. One control, tokens only: active pill = accent-dim fill +
// accent text, inactive = transparent + muted text with a hairline border.
//
// Client-safe but hook-free — it just renders links or buttons the caller
// wires up. Two modes:
//   • href mode  — each option carries an `href`; renders <a> (server-safe,
//                  works with Next server components + URL-driven filters).
//   • onSelect   — controlled; renders <button> and calls back with the value.

import type { CSSProperties, ReactNode } from 'react';

export type FilterOption = {
  value: string;
  label: ReactNode;
  href?: string;
  count?: number;
};

const pillBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.2,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--fg-muted)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  transition: 'background 100ms ease, color 100ms ease, border-color 100ms ease',
};

const pillActive: CSSProperties = {
  background: 'var(--accent-dim)',
  color: 'var(--accent)',
  borderColor: 'transparent',
};

const pillInactive: CSSProperties = {
  borderColor: 'var(--border)',
};

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 11,
        fontWeight: 700,
        opacity: active ? 0.9 : 0.7,
      }}
    >
      {n}
    </span>
  );
}

export function FilterPills({
  options,
  active,
  onSelect,
  style,
  'aria-label': ariaLabel,
}: {
  options: FilterOption[];
  /** The currently-selected value. */
  active: string;
  /** Controlled mode — omit when using `href` options. */
  onSelect?: (value: string) => void;
  style?: CSSProperties;
  'aria-label'?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...style }}
    >
      {options.map((opt) => {
        const isActive = opt.value === active;
        const st: CSSProperties = {
          ...pillBase,
          ...(isActive ? pillActive : pillInactive),
        };
        const inner = (
          <>
            {opt.label}
            {typeof opt.count === 'number' && <Count n={opt.count} active={isActive} />}
          </>
        );
        if (opt.href) {
          return (
            <a key={opt.value} href={opt.href} style={st} aria-current={isActive ? 'true' : undefined}>
              {inner}
            </a>
          );
        }
        return (
          <button
            key={opt.value}
            type="button"
            style={st}
            aria-pressed={isActive}
            onClick={onSelect ? () => onSelect(opt.value) : undefined}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
