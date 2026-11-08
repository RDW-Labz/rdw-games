// Money helpers — every monetary value in this codebase is integer cents.
// Never floats. Never strings until display. Never NUMERIC.

export type Cents = number;
export type Bps = number; // basis points, 1/100th of a percent (10000 = 100%)

export function applyBps(amount: Cents, bps: Bps): Cents {
  return Math.round((amount * bps) / 10000);
}

export function formatCents(cents: Cents | null | undefined, currency = 'USD'): string {
  if (cents == null) return '—';
  const value = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function dollarsToCents(dollars: string | number): Cents {
  // Accept human-entered strings with a leading "$", thousands commas, and
  // surrounding whitespace (e.g. "$1,299.00") — strip them before parsing so a
  // formatted MSRP doesn't read as NaN. Numbers pass through untouched.
  const n =
    typeof dollars === 'string' ? Number(dollars.replace(/[$,\s]/g, '')) : dollars;
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid dollar amount: ${dollars}`);
  }
  return Math.round(n * 100);
}
