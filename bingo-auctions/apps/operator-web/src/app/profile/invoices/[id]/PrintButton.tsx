// Print button — single-purpose client component because window.print()
// is browser-only. Extracted from the receipt page so the rest of the
// detail view stays a server component (RLS-aware data fetch + zero
// hydration cost).

'use client';

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="btn-secondary"
      style={{
        padding: '0.6rem 1.25rem',
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      Print receipt
    </button>
  );
}
