'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents, formatCents } from '@auction-platform/shared';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { refundErrorMessage, refundLotAvailability, type RefundLineState } from '@/lib/refund-copy';
import { inFlightGate } from '@/lib/in-flight-gate';

export type RefundLot = {
  lotId: string;
  title: string;
  lotCode?: string | null;
  refundCents: number;
  /** From the invoice page's line state. Missing = treat as refundable. */
  state?: RefundLineState;
  stateWhen?: string | null;
};

const ITEM_SUB_REASONS = [
  { value: 'wrong_item', label: 'Wrong / missing item' },
  { value: 'defective_item', label: 'Defective / not as described' },
  { value: 'damaged_in_transit', label: 'Damaged' },
  { value: 'other', label: 'Other' },
] as const;

export function RefundButton({
  invoiceId,
  maxRefundCents,
  lots = [],
}: {
  invoiceId: string;
  maxRefundCents: number;
  lots?: RefundLot[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Per-lot selection (auto-calculated amounts).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subReason, setSubReason] = useState<(typeof ITEM_SUB_REASONS)[number]['value']>('wrong_item');

  // Flat / custom-amount fallback.
  const [amount, setAmount] = useState((maxRefundCents / 100).toFixed(2));
  const [reason, setReason] = useState<'requested_by_customer' | 'duplicate' | 'fraudulent'>(
    'requested_by_customer',
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The double-click (2026-10-05: 13 lines refunded twice, one or two minutes
  // apart). `loading` disables the buttons on re-render; the gate drops a
  // second click that lands before that re-render. The server refuses the
  // same refund shape again for a minute on top (refund_in_flight).
  const gate = useRef(inFlightGate()).current;

  const selectedTotal = useMemo(
    () => lots.filter((l) => selected.has(l.lotId)).reduce((s, l) => s + l.refundCents, 0),
    [lots, selected],
  );

  function toggle(lotId: string) {
    const lot = lots.find((l) => l.lotId === lotId);
    if (lot && !refundLotAvailability(lot.state ?? 'owed', lot.stateWhen).refundable) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) next.delete(lotId);
      else next.add(lotId);
      return next;
    });
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={secondaryButtonStyle}>
        Refund
      </button>
    );
  }

  async function refundSelectedItems() {
    if (!gate.enter()) return;
    setError(null);
    setLoading(true);
    try {
      const items = lots
        .filter((l) => selected.has(l.lotId))
        .map((l) => ({ lot_id: l.lotId, amount_cents: l.refundCents }));
      const res = await fetch(`/api/invoices/${invoiceId}/refund-items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, sub_reason: subReason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(refundErrorMessage(err, res.status, maxRefundCents));
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setLoading(false);
      gate.leave();
    }
  }

  async function refundCustomAmount() {
    if (!gate.enter()) return;
    setError(null);
    setLoading(true);
    try {
      let cents: number;
      try {
        cents = dollarsToCents(amount);
      } catch {
        setError('Invalid amount');
        return;
      }
      const res = await fetch(`/api/invoices/${invoiceId}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: cents, reason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(refundErrorMessage(err, res.status, maxRefundCents));
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setLoading(false);
      gate.leave();
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: 13, color: 'var(--fg-muted)' };

  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <h3 style={{ marginTop: 0 }}>Issue refund</h3>

      {/* ── Per-lot refund (auto-calculated) ── */}
      {lots.length > 0 && (
        <div style={{ marginBottom: '1.25rem' }}>
          <p style={{ ...labelStyle, marginTop: 0 }}>
            Refund specific items — each amount already includes its share of the
            buyer&apos;s premium and sales tax:
          </p>
          <div style={{ display: 'grid', gap: 6, marginBottom: '0.6rem' }}>
            {lots.map((l) => {
              const avail = refundLotAvailability(l.state ?? 'owed', l.stateWhen);
              return (
              <label
                key={l.lotId}
                title={avail.note ?? undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 14,
                  opacity: avail.refundable ? 1 : 0.55,
                  cursor: avail.refundable ? 'pointer' : 'not-allowed',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(l.lotId)}
                  disabled={!avail.refundable}
                  onChange={() => toggle(l.lotId)}
                />
                <span style={{ flex: 1 }}>
                  {l.lotCode && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-muted)',
                        marginRight: 8,
                      }}
                    >
                      {l.lotCode}
                    </span>
                  )}
                  {l.title}
                  {avail.note && (
                    <span style={{ ...labelStyle, marginLeft: 8 }}>— {avail.note}</span>
                  )}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {formatCents(l.refundCents)}
                </span>
              </label>
              );
            })}
          </div>
          <label style={{ display: 'grid', gap: 4, marginBottom: '0.6rem' }}>
            <span style={labelStyle}>Reason</span>
            <select
              value={subReason}
              onChange={(e) => setSubReason(e.target.value as typeof subReason)}
              style={inputStyle}
            >
              {ITEM_SUB_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={refundSelectedItems}
            disabled={loading || selected.size === 0}
            style={{ ...buttonStyle, opacity: loading || selected.size === 0 ? 0.5 : 1 }}
          >
            {loading
              ? 'Refunding…'
              : `Refund ${selected.size} item${selected.size === 1 ? '' : 's'} — ${formatCents(selectedTotal)}`}
          </button>
          <div
            style={{
              borderTop: '1px solid var(--border)',
              margin: '1.1rem 0 0.9rem',
              paddingTop: '0.9rem',
              ...labelStyle,
            }}
          >
            Or refund a custom amount:
          </div>
        </div>
      )}

      {/* ── Flat / custom amount ── */}
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelStyle}>
            Amount ($) — up to {formatCents(maxRefundCents)}
            {maxRefundCents === 0 ? ' (nothing left to refund on this invoice)' : ' left to refund'}
          </span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max={(maxRefundCents / 100).toFixed(2)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelStyle}>Reason</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
            style={inputStyle}
          >
            <option value="requested_by_customer">Requested by customer</option>
            <option value="duplicate">Duplicate</option>
            <option value="fraudulent">Fraudulent</option>
          </select>
        </label>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={refundCustomAmount}
            disabled={loading || maxRefundCents === 0}
            style={{ ...buttonStyle, opacity: loading || maxRefundCents === 0 ? 0.5 : 1 }}
          >
            {loading ? 'Refunding…' : 'Refund custom amount'}
          </button>
          <button onClick={() => setOpen(false)} style={secondaryButtonStyle}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
