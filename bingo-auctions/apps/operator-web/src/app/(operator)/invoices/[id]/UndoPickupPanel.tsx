'use client';

// Undo pickup (mig 0487, owner decision 2026-11-03 via #706).
//
// Nothing in the console could ever clear invoice_lots.picked_up_at — the scan
// path and the manual override only stamp it — so a wrong "picked up" needed a
// bespoke migration per lot. #702 (TEA3828564) is that: marked picked up by
// mistake with the box still on the shelf. This panel clears ONE line's stamp
// through undo_invoice_line_pickup(), which checks the ADMIN role, the reason,
// the line state and the relist lineage server-side and writes the audit row.
// It moves no money and sends no notification.
//
// #706 narrows this to admins (the manager pickup override stays as it is).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  undoPickupDoneMessage,
  undoPickupErrorMessage,
  undoPickupInputError,
  type UndoPickupResult,
} from '@/lib/undo-pickup';

export type PickedUpLot = {
  lotId: string;
  title: string;
  lotCode: string | null;
  /** "Picked up Oct 27, 3:12 PM" from the invoice page. */
  pickedUpWhen: string | null;
  /** The line is also forfeited (0256 forfeited-not-resold path). */
  forfeited?: boolean;
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

export function UndoPickupPanel({
  invoiceId,
  pickedUpLots,
}: {
  invoiceId: string;
  pickedUpLots: PickedUpLot[];
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lotId, setLotId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (pickedUpLots.length === 0 && !done) return null;

  const selected = pickedUpLots.find((l) => l.lotId === lotId) ?? null;

  async function submit() {
    if (busy) return;
    setError(null);
    const inputError = undoPickupInputError({ lotId, reason });
    if (inputError) {
      setError(inputError);
      return;
    }
    if (!confirmed) {
      setError('Tick the confirm box — this puts the item back on the pickup list.');
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('undo_invoice_line_pickup', {
        p_invoice_id: invoiceId,
        p_lot_id: lotId,
        p_reason: reason.trim(),
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const result = data as UndoPickupResult;
      if (!result?.ok) {
        setError(undoPickupErrorMessage(result));
        return;
      }
      setDone(undoPickupDoneMessage(result));
      setOpen(false);
      setLotId(null);
      setReason('');
      setConfirmed(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo pickup failed. Nothing was changed.');
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
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Undo pickup</h2>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Admin only. For an item marked picked up by mistake. Clears the pickup stamp on one
            item so it is owed again and reappears on the pickup list. Needs a reason and writes
            the audit log. It does not move money or refund anything.
          </p>
        </div>
        {!open && pickedUpLots.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setDone(null); }}>
            Undo a pickup
          </button>
        )}
      </div>

      {done && (
        <p style={{ fontSize: 13, color: 'var(--success, #4ade80)', marginTop: '0.75rem' }}>{done}</p>
      )}

      {open && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.75rem' }}>
          <span style={captionStyle}>Items marked picked up</span>
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {pickedUpLots.map((lot) => (
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
                  name="undo-pickup-lot"
                  checked={lotId === lot.lotId}
                  onChange={() => { setLotId(lot.lotId); setConfirmed(false); }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {lot.title}
                  {lot.lotCode && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      {lot.lotCode}
                    </span>
                  )}
                  {lot.pickedUpWhen && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontSize: 12 }}>
                      Picked up {lot.pickedUpWhen}
                    </span>
                  )}
                  {lot.forfeited && (
                    <span style={{ color: 'var(--warning, #f0a83c)', marginLeft: 6, fontSize: 12, fontWeight: 600 }}>
                      Also forfeited
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Why this pickup was wrong (required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. wrong lot scanned at the counter on Oct 27; the box is still in bin 14"
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          </label>

          {selected && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Confirm: the customer did not take this item, and it goes back on the pickup list
                {selected.forfeited ? ' (the forfeit stays until you undo it)' : ''}.
              </span>
            </label>
          )}

          {error && <p style={{ fontSize: 13, color: 'var(--danger, #f87171)', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || !confirmed || !lotId}
            >
              {busy ? 'Saving…' : 'Undo pickup'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
