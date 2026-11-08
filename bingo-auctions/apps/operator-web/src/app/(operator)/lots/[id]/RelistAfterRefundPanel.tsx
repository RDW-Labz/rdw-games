'use client';

// Relist after refund (mig 0475, owner 2026-10-28). A lot whose sale was
// fully refunded and never left the building goes back to inventory only with
// a manager's PIN (the floor shares one admin login), a typed name and a
// reason. relist_refunded_lot() checks everything again and writes the audit
// row. The new copy goes to inventory; list it from there as usual.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  relistAfterRefundInputError,
  relistAfterRefundMessage,
  type RelistAfterRefundResult,
} from '@/lib/relist-after-refund';

type Worker = { id: string; display_name: string; role: string };

const fieldStyle = {
  padding: '0.45rem 0.6rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
} as const;
const captionStyle = { fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' } as const;

export function RelistAfterRefundPanel({ lotId, operatorId }: { lotId: string; operatorId: string }) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const router = useRouter();
  const [managers, setManagers] = useState<Worker[]>([]);
  const [managerId, setManagerId] = useState('');
  const [pin, setPin] = useState('');
  const [staffName, setStaffName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase.rpc('list_active_workers', { p_operator_id: operatorId }).then(({ data }) => {
      if (!alive) return;
      setManagers(((data ?? []) as Worker[]).filter((w) => w.role === 'manager' || w.role === 'admin'));
    });
    return () => {
      alive = false;
    };
  }, [supabase, operatorId]);

  async function submit() {
    if (busy) return;
    setError(null);
    const inputError = relistAfterRefundInputError({ managerId, pin, staffName, reason });
    if (inputError) {
      setError(inputError);
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('relist_refunded_lot', {
        p_lot_id: lotId,
        p_manager_worker_id: managerId,
        p_pin: pin.trim(),
        p_staff_name: staffName.trim(),
        p_reason: reason.trim(),
        p_auction_id: null,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const result = data as RelistAfterRefundResult;
      setPin('');
      if (!result?.ok) {
        setError(relistAfterRefundMessage(result));
        return;
      }
      setDone(relistAfterRefundMessage(result));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relist failed. Nothing changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Back to inventory after refund</h2>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
        This item&apos;s sale was refunded and it never left the building. Check the box is on its
        shelf and sellable. A manager approves with their PIN; your name and the reason go in the
        audit log. The refund and the buyer stay in the history.
      </p>
      {done ? (
        <p style={{ fontSize: 13, color: 'var(--success, #4ade80)', marginTop: '0.75rem' }}>{done}</p>
      ) : (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.75rem', maxWidth: 420 }}>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Manager approving</span>
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} style={fieldStyle}>
              <option value="">Select…</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Manager PIN</span>
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} style={fieldStyle} />
          </label>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Your name</span>
            <input type="text" value={staffName} onChange={(e) => setStaffName(e.target.value)} maxLength={80} autoComplete="off" style={fieldStyle} />
          </label>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            <span style={captionStyle}>Why it can be sold again</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
              placeholder="e.g. box on 10-03-01, undamaged, refunded because the buyer changed their mind"
              style={{ ...fieldStyle, resize: 'vertical' }} />
          </label>
          {error && <p style={{ fontSize: 13, color: 'var(--danger, #f87171)', margin: 0 }}>{error}</p>}
          <div>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : 'Put back in inventory'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
