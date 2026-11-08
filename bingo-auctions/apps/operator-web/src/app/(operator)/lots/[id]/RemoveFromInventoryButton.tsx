'use client';

// The other branch of the relot decision (mig 0319). A refunded / returned item
// is back on the bench: relot it, or decide it can't be sold again and retire
// it for good. This is the second one.
//
// Two things drive the design:
//
//   1. IT IS PERMANENT except for one escape hatch: an admin may undo it
//      within 24 hours (mig 0471, typed name + reason). After that the
//      database pins a removed lot to disposed and refuses any status change.
//      That earns a real confirmation step — an outcome has to be picked
//      explicitly, and destroying additionally needs the lot code typed. A
//      plain confirm() would be too easy to click through on a phone.
//
//   2. DESTROYED AND BIN STORE ARE NOT THE SAME EVENT. The whole point of the
//      request was to stop "moved to Been There Bought That" being recorded as
//      "destroyed". So the outcome is a deliberate choice, not a side effect,
//      and the copy says what each one means.

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { secondaryButtonStyle } from '@/components/Form';
import { confirmCodeMatches } from '@/lib/removal-confirm-code';
import { removeLotFromInventory } from './actions';
import { StaffAttributionFields, attributionComplete } from './StaffAttributionFields';

type Kind = 'destroyed' | 'bin_store' | 'donated' | 'liquidated' | 'missing' | 'other';

const OUTCOMES: { value: Kind; label: string; help: string }[] = [
  {
    value: 'destroyed',
    label: 'Destroyed',
    help: 'Damaged or trash. The item is physically gone and will never be auctioned again.',
  },
  {
    value: 'bin_store',
    label: 'Transferred to Been There Bought That',
    help: 'Goes to the bin store instead of auction. Out of auction inventory, but not destroyed.',
  },
  { value: 'donated', label: 'Donated', help: 'Given away rather than sold.' },
  {
    value: 'liquidated',
    label: 'Liquidated',
    help: 'Sold off outside the auction — pallet, bulk buyer, scrap.',
  },
  {
    value: 'missing',
    label: 'Missing — not on the shelf',
    help: 'Searched the recorded location and it is not there. Use this rather than Other so it shows up in the missing-item reports. If it turns up later, it gets re-lotted as a new lot.',
  },
  { value: 'other', label: 'Other', help: 'Anything else. Say what happened in the note.' },
];

const noStickerFlagStyle: CSSProperties = {
  marginLeft: 8,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--warning, #fbbf24)',
  border: '1px solid var(--warning, #fbbf24)',
  borderRadius: 4,
  padding: '1px 6px',
  verticalAlign: 'middle',
};

export function RemoveFromInventoryButton({
  lotId,
  confirmCode,
  secondaryCode,
  noSticker,
}: {
  lotId: string;
  confirmCode: string;
  secondaryCode: string | null;
  noSticker: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [staffName, setStaffName] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Destroying is the one that ends with a thing in a skip, so it gets the
  // type-the-code gate. The others are recoverable in the real world even
  // though the record isn't.
  const needsTypedCode = kind === 'destroyed';
  const canSubmit =
    kind !== null &&
    attributionComplete(staffName, reason) &&
    (!needsTypedCode || confirmCodeMatches(typed, confirmCode)) &&
    !busy;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...secondaryButtonStyle, color: 'var(--danger)' }}
      >
        Remove from inventory
      </button>
    );
  }

  return (
    <div
      style={{
        border: '1px solid rgba(255,84,112,0.4)',
        background: 'rgba(255,84,112,0.06)',
        borderRadius: 8,
        padding: '1rem',
        maxWidth: 560,
        display: 'grid',
        gap: 12,
      }}
    >
      <div>
        <strong style={{ fontSize: 14 }}>
          Remove {confirmCode} from auction inventory
          {secondaryCode != null && (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 8, fontWeight: 400 }}>
              {secondaryCode}
            </span>
          )}
          {noSticker && <span style={noStickerFlagStyle}>no sticker</span>}
        </strong>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '4px 0 0' }}>
          This lot record is closed for good. If a Missing box turns up later, it gets re-lotted
          as a new lot. An admin can undo this within 24 hours; after that it can&apos;t be
          changed. If you might still sell it, relot it instead.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {OUTCOMES.map((o) => (
          <label
            key={o.value}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}
          >
            <input
              type="radio"
              name="removal-kind"
              value={o.value}
              checked={kind === o.value}
              onChange={() => {
                setKind(o.value);
                setTyped('');
                setError(null);
              }}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{o.label}</strong>
              <br />
              <span style={{ color: 'var(--fg-muted)' }}>{o.help}</span>
            </span>
          </label>
        ))}
      </div>

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
        reasonPlaceholder="e.g. water damage, box crushed in transit"
      />

      {needsTypedCode && (
        <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
          {noSticker ? (
            <>
              Type <strong>{confirmCode}</strong> to confirm you are destroying this item
            </>
          ) : (
            <>
              Type the sticker code <strong>{confirmCode}</strong> from the box to confirm you are
              destroying this item
            </>
          )}
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' }}
          />
        </label>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          disabled={!canSubmit}
          onClick={async () => {
            if (!kind) return;
            setBusy(true);
            setError(null);
            const result = await removeLotFromInventory({
              lotId,
              kind,
              staffName: staffName.trim(),
              reason: reason.trim(),
            });
            setBusy(false);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setOpen(false);
            router.refresh();
          }}
          style={{
            ...secondaryButtonStyle,
            color: 'var(--danger)',
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? '…' : 'Remove permanently'}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setKind(null);
            setStaffName('');
            setReason('');
            setTyped('');
            setError(null);
          }}
          disabled={busy}
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
