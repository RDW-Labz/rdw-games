// MoneyText / MonoText — the single numeric-typography primitives for the
// operator console.
//
// Every price/count in the console should read in the mono "ticket" face with
// tabular numerals so columns line up. These wrap that styling once instead of
// each page re-adding `fontFamily: var(--font-mono)` inline.
//
//   • MonoText  — any monospaced tabular value (counts, lot codes, dates).
//   • MoneyText — MonoText specialized for integer-cents money: formats via the
//                 shared formatCents and can tone negative/owed amounts red and
//                 collected amounts green.

import type { CSSProperties, ReactNode } from 'react';
import { formatCents } from '@auction-platform/shared/money';

const monoBase: CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontVariantNumeric: 'tabular-nums',
};

export function MonoText({
  children,
  dim = false,
  style,
}: {
  children: ReactNode;
  /** Render in the dim tertiary color (for secondary codes/dates). */
  dim?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span style={{ ...monoBase, ...(dim ? { color: 'var(--fg-dim)' } : {}), ...style }}>
      {children}
    </span>
  );
}

type MoneyTone = 'default' | 'owed' | 'collected' | 'auto';

function toneColor(tone: MoneyTone, cents: number | null | undefined): string | undefined {
  switch (tone) {
    case 'owed':
      return 'var(--danger)';
    case 'collected':
      return 'var(--success)';
    case 'auto':
      // Negative = money out/owed (red); positive = neutral.
      return cents != null && cents < 0 ? 'var(--danger)' : undefined;
    default:
      return undefined;
  }
}

export function MoneyText({
  cents,
  tone = 'default',
  bold = false,
  style,
}: {
  cents: number | null | undefined;
  /** owed → red, collected → green, auto → red when negative. */
  tone?: MoneyTone;
  bold?: boolean;
  style?: CSSProperties;
}) {
  const color = toneColor(tone, cents);
  return (
    <span
      style={{
        ...monoBase,
        ...(color ? { color } : {}),
        ...(bold ? { fontWeight: 700 } : {}),
        ...style,
      }}
    >
      {formatCents(cents)}
    </span>
  );
}
