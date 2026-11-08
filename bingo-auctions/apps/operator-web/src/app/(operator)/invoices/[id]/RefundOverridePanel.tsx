'use client';

// Refund override (mig 0474, 2026-10-27, Jared). Manager/admin only, on a
// paid invoice with no card payment (settled offline or with account credit),
// where Square has nothing to refund. Records a cash-from-drawer or
// account-credit refund for ONE item through record_refund_override(), which
// checks role, name, reason, the line-paid limit and the per-use and daily
// caps, and writes the audit row and the Refund overrides report row.
//
// The floor shares one console login, so the person types their name.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { formatCents } from '@auction-platform/shared/money';
import {
  REFUND_OVERRIDE_METHODS,
  parseDollarsToCents,
  refundOverrideDoneMessage,
  refundOverrideErrorMessage,
  refundOverrideInputError,
  type RefundOverrideMethod,
  type RefundOverrideResult,
} from '@/lib/refund-override';

export type OverrideRefundLot = {
  lotId: string;
  title: string;
  lotCode: string | null;
  /** What the line was paid: hammer + its share of premium and tax. */
  paidCents: number;
};

const fieldStyle = {
  padding: '0.45rem 0.6rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
} as const;

const captionStyle = { fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' } as const;

export function RefundOverridePanel({
  invoiceId,
  lots,
  methods,
}: {
  invoiceId: string;
  lots: OverrideRefundLot[];
  methods: RefundOverrideMethod[];
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lotId, setLotId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<RefundOverrideMethod | ''>(methods.length === 1 ? methods[0]! : '');
  const [staffName, setStaffName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (lots.length === 0 && !done) return null;
  const picked = lots.find((l) => l.lotId === lotId) ?? null;

  async function submit() {
    if (busy) return;
    setError(null);
    const amountCents = parseDollarsToCents(amount);
    const inputError = refundOverrideInputError({
      lotId,
      amountCents,
      lineMaxCents: picked?.paidCents ?? null,
      method,
      staffName,
      reason,
    });
    if (inputError) {
      setError(inputError);
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('record_refund_override', {
        p_invoice_id: invoiceId,
        p_lot_id: lotId,
        p_amount_cents: amountCents,
        p_method: method,
        p_staff_name: staffName.trim(),
        p_reason: reason.trim(),
        p_cause: 'no_card_payment',
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const result = data as RefundOverrideResult;
      if (!result?.ok) {
        setError(refundOverrideErrorMessage(result));
        return;
      }
      setDone(refundOverrideDoneMessage(result, picked?.lotCode ?? null));
      setOpen(false);
      setLotId(null);
      setAmount('');
      setReason('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refund override failed. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      style={{
        marginTop: '2rem',
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Refund override</h2>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Manager/admin only. This invoice was not paid by card, so Square cannot refund it.
            Record the refund here as cash from the drawer or as account credit, one item at a
            time, up to what the item was paid. Needs your name and a reason; every use is in the
            audit log and the Refund overrides report.
          </p>
        </div>
        {!open && lots.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setDone(null); }}>
            Refund override
          </button>
        )}
      </div>

      {done && <p style={{ fontSize: 13, color: 'var(--success, #4ade80)', marginTop: '0.75rem' }}>{done}</p>}

      {open && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.75rem' }}>
          <span style={captionStyle}>Item</span>
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {lots.map((lot) => (
              <label
                key={lot.lotId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  fontSize: 13,
                  padding: '0.45rem 0.6rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: lotId === lot.lotId ? 'var(--bg)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="refund-override-lot"
                  checked={lotId === lot.lotId}
                  onChange={() => {
                    setLotId(lot.lotId);
                    setAmount((lot.paidCents / 100).toFixed(2));
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {lot.title}
                  {lot.lotCode && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      {lot.lotCode}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>paid {formatCents(lot.paidCents)}</span>
              </label>
            ))}
          </div>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Amount (up to what the item was paid)</span>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={fieldStyle} />
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>How it goes back (required)</span>
            <select value={method} onChange={(e) => setMethod(e.target.value as RefundOverrideMethod | '')} style={fieldStyle}>
              <option value="">Select…</option>
              {REFUND_OVERRIDE_METHODS.filter((m) => methods.includes(m.value)).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Your name (required)</span>
            <input
              type="text"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              maxLength={80}
              autoComplete="off"
              style={fieldStyle}
            />
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Why (required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. lock broken when the customer opened it at the counter"
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          </label>

          {error && <p style={{ fontSize: 13, color: 'var(--danger, #f87171)', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : 'Record refund'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
