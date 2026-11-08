'use client';

// Manager Manual Pickup Override (owner request 2026-07-10).
//
// When the counter releases items without the scan path recording it
// (scanner glitch, dead QR, support-approved exception), the system still
// thinks they're owed and the no-show/forfeit/relot machinery can fire on
// merchandise that already left the building. This panel lets a manager or
// admin stamp individual lots — or the whole invoice — as picked up, with a
// MANDATORY reason. All writes go through the manager_pickup_override RPC
// (mig 0256): role-gated server-side, idempotent stamps, 0217/0245
// completion semantics, and an operator_audit_log row every time (who, when,
// which lots, why).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

const REASONS = [
  { value: 'system_glitch', label: 'System glitch' },
  { value: 'scanner_issue', label: 'Scanner issue' },
  { value: 'support_approved', label: 'Support approved' },
  { value: 'other', label: 'Other (note required)' },
] as const;

type ReasonValue = (typeof REASONS)[number]['value'];

export type OverrideLot = {
  lotId: string;
  title: string;
  lotCode: string | null;
  /** Forfeited by the no-show sweep, lot never resold (lib/pickup-override-offer). */
  forfeitedNotResold?: boolean;
};

type RpcResult = {
  ok: boolean;
  error?: string;
  picked_count?: number;
  remaining_count?: number;
  pickup_completed?: boolean;
};

const RPC_ERROR_COPY: Record<string, string> = {
  manager_or_admin_only: 'Only managers and admins can record a pickup override.',
  invoice_not_paid: 'This invoice is not paid — overrides only apply to paid invoices.',
  note_required_for_other: 'Add a note explaining the override.',
  invalid_reason: 'Pick a reason for the override.',
  lot_not_on_invoice_or_refunded:
    'One of the selected lots is not on this invoice or was refunded.',
};

export function ManualPickupOverride({
  invoiceId,
  owedLots,
}: {
  invoiceId: string;
  /** Lots still owed, plus forfeited lots that were never resold. */
  owedLots: OverrideLot[];
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ReasonValue | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (owedLots.length === 0 && !done) return null;

  const allSelected = selected.size === owedLots.length && owedLots.length > 0;

  function toggle(lotId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) next.delete(lotId);
      else next.add(lotId);
      return next;
    });
  }

  async function submit() {
    if (busy) return;
    setError(null);
    if (selected.size === 0) {
      setError('Select at least one item (or Select all for the whole invoice).');
      return;
    }
    if (!reason) {
      setError('Pick a reason — it goes in the audit log.');
      return;
    }
    if (reason === 'other' && note.trim() === '') {
      setError('Add a note explaining the override.');
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('manager_pickup_override', {
        p_invoice_id: invoiceId,
        p_lot_ids: Array.from(selected),
        p_reason: reason,
        p_note: note.trim() || null,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const result = data as RpcResult;
      if (!result?.ok) {
        setError(RPC_ERROR_COPY[result?.error ?? ''] ?? `Override failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      setDone(
        `Marked ${result.picked_count} item(s) picked up.` +
          (result.pickup_completed
            ? ' Invoice pickup is now complete.'
            : ` ${result.remaining_count} item(s) still owed.`),
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Override failed — try again.');
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
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Manual pickup override</h2>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Manager/admin only. Marks items as picked up when the scan path failed —
            requires a reason and writes the audit log. Use this so released items are
            never no-showed, forfeited, or relotted.
          </p>
        </div>
        {!open && owedLots.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setDone(null); }}>
            Record override
          </button>
        )}
      </div>

      {done && (
        <p style={{ fontSize: 13, color: 'var(--success, #4ade80)', marginTop: '0.75rem' }}>{done}</p>
      )}

      {open && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
              Items still owed
            </span>
            <button
              type="button"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(owedLots.map((l) => l.lotId)))
              }
              style={{
                fontSize: 12,
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                padding: 0,
                fontWeight: 600,
              }}
            >
              {allSelected ? 'Clear selection' : 'Select all (entire invoice)'}
            </button>
          </div>

          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {owedLots.map((lot) => (
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
                  background: selected.has(lot.lotId) ? 'var(--bg)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(lot.lotId)}
                  onChange={() => toggle(lot.lotId)}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {lot.title}
                  {lot.lotCode && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      {lot.lotCode}
                    </span>
                  )}
                  {lot.forfeitedNotResold && (
                    <span style={{ color: 'var(--warning, #f0a83c)', marginLeft: 6, fontSize: 12, fontWeight: 600 }}>
                      Forfeited · never resold
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {owedLots.some((l) => l.forfeitedNotResold && selected.has(l.lotId)) && (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: 0, lineHeight: 1.5 }}>
              Only for an item that really left the building. Marking a forfeited item picked up
              records it as collected today, sends the customer a pickup-confirmed notice, and
              stops it from being relisted. It does not change the payment or issue a refund.
            </p>
          )}

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
              Reason (required)
            </span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as ReasonValue | '')}
              style={{
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
                fontSize: 13,
              }}
            >
              <option value="">Select a reason…</option>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
              Note{reason === 'other' ? ' (required)' : ' (optional)'}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="What happened? e.g. scanner froze at counter, item released to customer at 2:15pm"
              style={{
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
                fontSize: 13,
                resize: 'vertical',
              }}
            />
          </label>

          {error && <p style={{ fontSize: 13, color: 'var(--danger, #f87171)', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy
                ? 'Recording…'
                : `Mark ${selected.size || '…'} item(s) picked up`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
