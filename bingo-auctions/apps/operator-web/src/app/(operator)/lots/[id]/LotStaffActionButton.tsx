'use client';

// One button + typed-name/reason form for the mig 0471 lot actions:
// withdraw from auction, undo a withdrawal, undo a Dispose / Business use.
// Each needs a typed staff name and a reason; the server checks role, state
// and the 24-hour / auction-close windows and says why when it refuses.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { secondaryButtonStyle } from '@/components/Form';
import { undoLotRemoval, undoLotWithdrawal, withdrawLotFromAuction } from './actions';
import { StaffAttributionFields, attributionComplete } from './StaffAttributionFields';

export type LotStaffActionKind = 'withdraw' | 'undo_withdraw' | 'undo_removal';

const COPY: Record<LotStaffActionKind, { button: string; confirm: string; reasonPlaceholder: string; danger: boolean }> = {
  withdraw: {
    button: 'Withdraw from auction',
    confirm: 'Withdraw',
    reasonPlaceholder: 'e.g. damaged, missing parts, wrong item',
    danger: true,
  },
  undo_withdraw: {
    button: 'Put back in the auction',
    confirm: 'Put back',
    reasonPlaceholder: 'e.g. withdrawn by mistake',
    danger: false,
  },
  undo_removal: {
    button: 'Undo (admin, within 24 hours)',
    confirm: 'Undo',
    reasonPlaceholder: 'e.g. disposed the wrong lot',
    danger: false,
  },
};

const RUN = {
  withdraw: withdrawLotFromAuction,
  undo_withdraw: undoLotWithdrawal,
  undo_removal: undoLotRemoval,
} as const;

export function LotStaffActionButton({
  lotId,
  kind,
  explainer,
}: {
  lotId: string;
  kind: LotStaffActionKind;
  /** What will happen, in plain words (e.g. "3 bidders will be notified"). */
  explainer?: string;
}) {
  const router = useRouter();
  const copy = COPY[kind];
  const [open, setOpen] = useState(false);
  const [staffName, setStaffName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = attributionComplete(staffName, reason) && !busy;

  function reset() {
    setOpen(false);
    setStaffName('');
    setReason('');
    setError(null);
  }

  const buttonStyle = copy.danger ? { ...secondaryButtonStyle, color: 'var(--danger)' } : secondaryButtonStyle;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={buttonStyle}>
        {copy.button}
      </button>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '1rem',
        maxWidth: 560,
        display: 'grid',
        gap: 12,
      }}
    >
      {explainer && <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>{explainer}</p>}
      <StaffAttributionFields
        staffName={staffName}
        reason={reason}
        onStaffName={(v) => {
          setStaffName(v);
          setError(null);
        }}
        onReason={(v) => {
          setReason(v);
          setError(null);
        }}
        reasonPlaceholder={copy.reasonPlaceholder}
      />
      {error && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          disabled={!canSubmit}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const result = await RUN[kind]({ lotId, staffName: staffName.trim(), reason: reason.trim() });
            setBusy(false);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            reset();
            router.refresh();
          }}
          style={{ ...buttonStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
        >
          {busy ? '…' : copy.confirm}
        </button>
        <button onClick={reset} disabled={busy} style={secondaryButtonStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}
