'use client';

// Undo forfeit (mig 0444, owner decision 2026-10-22).
//
// The no-show sweep stamps a pickup's open lines forfeited, and a forfeited
// line cannot be refunded or (once relisted) marked picked up. Staff report:
// one line was forfeited while the customer was at the counter mid-handover.
// This panel clears ONE line's forfeit through undo_invoice_line_forfeit(),
// which checks role, reason, name and the relist lineage server-side and
// writes the audit row. It moves no money: staff then use Refund items or
// Manual pickup override as usual.
//
// The floor shares one console login, so the person types their name; it goes
// into the audit row next to the account.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  UNDO_FORFEIT_PURPOSES,
  undoForfeitDoneMessage,
  undoForfeitErrorMessage,
  undoForfeitInputError,
  type UndoForfeitPurpose,
  type UndoForfeitResult,
} from '@/lib/undo-forfeit';

export type ForfeitedLot = {
  lotId: string;
  title: string;
  lotCode: string | null;
  /** "Forfeited Oct 18, 4:00 PM" from the invoice page. */
  forfeitedWhen: string | null;
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

export function UndoForfeitPanel({
  invoiceId,
  forfeitedLots,
}: {
  invoiceId: string;
  forfeitedLots: ForfeitedLot[];
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lotId, setLotId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<UndoForfeitPurpose | ''>('');
  const [doneBy, setDoneBy] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (forfeitedLots.length === 0 && !done) return null;

  async function submit() {
    if (busy) return;
    setError(null);
    const inputError = undoForfeitInputError({ lotId, purpose, reason, doneBy });
    if (inputError) {
      setError(inputError);
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('undo_invoice_line_forfeit', {
        p_invoice_id: invoiceId,
        p_lot_id: lotId,
        p_purpose: purpose,
        p_reason: reason.trim(),
        p_done_by: doneBy.trim(),
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const result = data as UndoForfeitResult;
      if (!result?.ok) {
        setError(undoForfeitErrorMessage(result));
        return;
      }
      setDone(undoForfeitDoneMessage(result));
      setOpen(false);
      setLotId(null);
      setPurpose('');
      setReason('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo forfeit failed. Nothing was changed.');
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
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Undo forfeit</h2>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Manager/admin only. For an item forfeited by mistake. Clears the forfeit on one item
            so you can refund it or mark it picked up. Needs your name and a reason, and writes
            the audit log. It does not refund anything by itself.
          </p>
        </div>
        {!open && forfeitedLots.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setDone(null); }}>
            Undo a forfeit
          </button>
        )}
      </div>

      {done && (
        <p style={{ fontSize: 13, color: 'var(--success, #4ade80)', marginTop: '0.75rem' }}>{done}</p>
      )}

      {open && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.75rem' }}>
          <span style={captionStyle}>Forfeited items</span>
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {forfeitedLots.map((lot) => (
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
                  name="undo-forfeit-lot"
                  checked={lotId === lot.lotId}
                  onChange={() => setLotId(lot.lotId)}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {lot.title}
                  {lot.lotCode && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      {lot.lotCode}
                    </span>
                  )}
                  {lot.forfeitedWhen && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontSize: 12 }}>
                      Forfeited {lot.forfeitedWhen}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Then (required)</span>
            <select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as UndoForfeitPurpose | '')}
              style={fieldStyle}
            >
              <option value="">Select…</option>
              {UNDO_FORFEIT_PURPOSES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Your name (required)</span>
            <input
              type="text"
              value={doneBy}
              onChange={(e) => setDoneBy(e.target.value)}
              maxLength={80}
              autoComplete="off"
              style={fieldStyle}
            />
          </label>

          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Why the forfeit was wrong (required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. customer was at the counter on Oct 18; this item was missed in the handover"
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          </label>

          {error && <p style={{ fontSize: 13, color: 'var(--danger, #f87171)', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : 'Undo forfeit'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
