'use client';

// Keep for business (mig 0381): the business keeps this item instead of
// auctioning it. Like a removal it is permanent (an admin can undo it within
// 24 hours, mig 0471) — so it gets an explicit form rather than a confirm(),
// with the typed staff name every lot action now needs. The price is what the item is recorded at (0 allowed); it is not
// a sale and never reaches a revenue figure.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { secondaryButtonStyle } from '@/components/Form';
import { hasAtMostTwoDecimals, KEEP_MAX_PRICE_CENTS } from '@/lib/keep-for-business';
import { keepLotForBusiness } from './actions';
import { StaffAttributionFields, attributionComplete } from './StaffAttributionFields';

const inputStyle = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' };

export function KeepForBusinessButton({ lotId, lotCode }: { lotId: string; lotCode: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [staffName, setStaffName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Blank is not $0 — staff have to type the 0 on purpose.
  const priceNum = price.trim() === '' ? NaN : Number(price);
  const priceOk =
    Number.isFinite(priceNum) &&
    priceNum >= 0 &&
    priceNum <= KEEP_MAX_PRICE_CENTS / 100 &&
    hasAtMostTwoDecimals(priceNum);
  const canSubmit = priceOk && attributionComplete(staffName, reason) && !busy;

  function reset() {
    setOpen(false);
    setPrice('');
    setReason('');
    setStaffName('');
    setError(null);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={secondaryButtonStyle}>
        Keep for business
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
      <div>
        <strong style={{ fontSize: 14 }}>Keep {lotCode} for the business</strong>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '4px 0 0' }}>
          This takes the item out of inventory and auctions for good. It is recorded at this price
          and is not a sale.
        </p>
      </div>

      <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
        Price ($)
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
            setError(null);
          }}
          placeholder="0.00"
          style={{ ...inputStyle, maxWidth: 160 }}
        />
        {price.trim() !== '' && !priceOk && (
          <span style={{ color: 'var(--danger)' }}>
            Enter $0 or more, with at most 2 decimal places.
          </span>
        )}
      </label>

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
        reasonPlaceholder="e.g. used as a shop fixture"
      />

      {error && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          disabled={!canSubmit}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const result = await keepLotForBusiness({
              lotId,
              priceDollars: priceNum,
              staffName: staffName.trim(),
              reason: reason.trim(),
            });
            setBusy(false);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            reset();
            router.refresh();
          }}
          style={{
            ...secondaryButtonStyle,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? '…' : 'Confirm'}
        </button>
        <button onClick={reset} disabled={busy} style={secondaryButtonStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}
