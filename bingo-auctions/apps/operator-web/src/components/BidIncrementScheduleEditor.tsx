'use client';

// BidIncrementScheduleEditor — shared tier editor for configurable bid-increment
// schedules (BID-3, mig 0194). Used by:
//   • Settings → Auction defaults (operators.bid_increment_schedule)
//   • Auction new / edit forms (auctions.bid_increment_schedule override)
//
// A schedule is an ASCENDING array of tiers { min_cents, step_cents }. The UI
// edits dollars; we store cents. An EMPTY list means "use the legacy ladder"
// (operator default) or "inherit the operator default" (auction override) — the
// caller persists null in that case.
//
// Validation rules (mirrored in the server zod schemas):
//   • first tier min_cents must be 0
//   • min_cents strictly ascending (no duplicates / overlaps)
//   • step_cents > 0, and >= MIN_STEP_CENTS ($0.25) as a sane floor
// Empty list is always valid (= NULL = legacy / inherit).

import { useId } from 'react';
import type { BidIncrementTier } from '@auction-platform/shared';
import { Field, inputStyle, secondaryButtonStyle } from './Form';

/** Suggested minimum step so operators don't set a 1-cent ladder. */
export const MIN_STEP_CENTS = 25;

/** A tier as edited in the form — dollar strings so typing "1." is allowed. */
export type TierDraft = { fromDollars: string; stepDollars: string };

// ── cents ⇄ dollar-string helpers ────────────────────────────────────────────

export function centsToDollarString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Parse a dollar string to integer cents. Returns null when not a finite >= 0 number. */
export function dollarStringToCents(s: string): number | null {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function tiersToDrafts(tiers: BidIncrementTier[] | null | undefined): TierDraft[] {
  if (!tiers || tiers.length === 0) return [];
  return tiers
    .slice()
    .sort((a, b) => a.min_cents - b.min_cents)
    .map((t) => ({
      fromDollars: centsToDollarString(t.min_cents),
      stepDollars: centsToDollarString(t.step_cents),
    }));
}

// ── validation (shared shape with the server zod schemas) ────────────────────

export type ScheduleParse =
  | { ok: true; tiers: BidIncrementTier[] | null }
  | { ok: false; error: string };

/**
 * Convert drafts → a validated tier array (or null for an empty list). This is
 * the single source of truth for the editor's client-side validation; the
 * server re-validates the resulting cents array with the same rules.
 */
export function parseDrafts(drafts: TierDraft[]): ScheduleParse {
  // Empty list → NULL (legacy ladder / inherit). Always valid.
  const nonEmpty = drafts.filter(
    (d) => d.fromDollars.trim() !== '' || d.stepDollars.trim() !== '',
  );
  if (nonEmpty.length === 0) return { ok: true, tiers: null };

  const tiers: BidIncrementTier[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const d = nonEmpty[i]!;
    const min_cents = dollarStringToCents(d.fromDollars);
    const step_cents = dollarStringToCents(d.stepDollars);
    if (min_cents === null) {
      return { ok: false, error: `Row ${i + 1}: enter a valid "price from" amount.` };
    }
    if (step_cents === null || step_cents <= 0) {
      return { ok: false, error: `Row ${i + 1}: increment must be greater than $0.` };
    }
    if (step_cents < MIN_STEP_CENTS) {
      return {
        ok: false,
        error: `Row ${i + 1}: increment must be at least ${centsToDollarString(MIN_STEP_CENTS)}.`,
      };
    }
    tiers.push({ min_cents, step_cents });
  }

  tiers.sort((a, b) => a.min_cents - b.min_cents);

  if (tiers[0]!.min_cents !== 0) {
    return { ok: false, error: 'The first tier must start at $0.00.' };
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i]!.min_cents <= tiers[i - 1]!.min_cents) {
      return {
        ok: false,
        error: 'Tier "price from" values must increase (no duplicates or overlaps).',
      };
    }
  }
  return { ok: true, tiers };
}

// ── component ────────────────────────────────────────────────────────────────

export function BidIncrementScheduleEditor({
  drafts,
  onChange,
  disabled = false,
  /** Heading + helper copy differ slightly between operator-default and override. */
  label = 'Bid increment schedule',
  hint,
  /** Shown when the list is empty — explains the NULL/legacy/inherit behavior. */
  emptyHint = 'No tiers — uses the default ladder. Add tiers to customize.',
}: {
  drafts: TierDraft[];
  onChange: (next: TierDraft[]) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  emptyHint?: string;
}) {
  const baseId = useId();

  const setRow = (idx: number, patch: Partial<TierDraft>) => {
    onChange(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };
  const addRow = () => {
    // First row defaults to $0.00 from; later rows leave "from" blank for the
    // operator to fill (it must be strictly greater than the previous tier).
    const fromDollars = drafts.length === 0 ? '0.00' : '';
    onChange([...drafts, { fromDollars, stepDollars: '' }]);
  };
  const removeRow = (idx: number) => {
    onChange(drafts.filter((_, i) => i !== idx));
  };

  // Live preview of validation so the operator sees errors before saving.
  const parsed = parseDrafts(drafts);

  return (
    <div style={{ display: 'grid', gap: '0.6rem' }}>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{hint}</div>}

      {drafts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{emptyHint}</div>
      ) : (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {/* Column headers */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr auto',
              gap: '0.5rem',
              fontSize: 11,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            <span>When current bid ≥</span>
            <span>Minimum increment</span>
            <span aria-hidden="true" />
          </div>

          {drafts.map((d, i) => {
            const fromId = `${baseId}-from-${i}`;
            const stepId = `${baseId}-step-${i}`;
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr auto',
                  gap: '0.5rem',
                  alignItems: 'end',
                }}
              >
                <Field label="" htmlFor={fromId}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: 'var(--fg-muted)' }}>$</span>
                    <input
                      id={fromId}
                      style={{ ...inputStyle, width: '100%' }}
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      // The first tier is conceptually fixed at $0.00; lock it so
                      // operators can't accidentally violate "first tier = $0".
                      value={i === 0 ? '0.00' : d.fromDollars}
                      disabled={disabled || i === 0}
                      placeholder="0.00"
                      onChange={(e) => setRow(i, { fromDollars: e.target.value })}
                      aria-label={`Tier ${i + 1} applies when the current bid is at or above this many dollars`}
                    />
                  </div>
                </Field>
                <Field label="" htmlFor={stepId}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: 'var(--fg-muted)' }}>$</span>
                    <input
                      id={stepId}
                      style={{ ...inputStyle, width: '100%' }}
                      type="number"
                      min={centsToDollarString(MIN_STEP_CENTS)}
                      step="0.01"
                      inputMode="decimal"
                      value={d.stepDollars}
                      disabled={disabled}
                      placeholder={centsToDollarString(MIN_STEP_CENTS)}
                      onChange={(e) => setRow(i, { stepDollars: e.target.value })}
                      aria-label={`Tier ${i + 1} minimum bid increment in dollars`}
                    />
                  </div>
                </Field>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={disabled}
                  style={{ ...secondaryButtonStyle, color: 'var(--danger)', padding: '0.5rem 0.75rem' }}
                  aria-label={`Remove tier ${i + 1}`}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          style={secondaryButtonStyle}
        >
          + Add tier
        </button>
      </div>

      {!parsed.ok && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>
          {parsed.error}
        </div>
      )}
    </div>
  );
}
