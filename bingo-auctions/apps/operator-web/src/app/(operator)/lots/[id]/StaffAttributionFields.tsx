'use client';

// Typed staff name + reason (mig 0471). Staff share one console login, so
// every lot action that changes what bidders or inventory see says who did it
// and why. Same fields as refunds (#598).

import { STAFF_NAME_MAX, STAFF_REASON_MAX } from '@/lib/lot-staff-action';

const inputStyle = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' };

export function StaffAttributionFields({
  staffName,
  reason,
  onStaffName,
  onReason,
  reasonLabel = 'Reason',
  reasonPlaceholder,
}: {
  staffName: string;
  reason: string;
  onStaffName: (v: string) => void;
  onReason: (v: string) => void;
  reasonLabel?: string;
  reasonPlaceholder?: string;
}) {
  return (
    <>
      <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
        Your name
        <input
          value={staffName}
          onChange={(e) => onStaffName(e.target.value)}
          maxLength={STAFF_NAME_MAX}
          autoComplete="off"
          placeholder="Who is doing this"
          style={{ ...inputStyle, maxWidth: 260 }}
        />
      </label>
      <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
        {reasonLabel}
        <input
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          maxLength={STAFF_REASON_MAX}
          placeholder={reasonPlaceholder}
          style={inputStyle}
        />
      </label>
    </>
  );
}

export function attributionComplete(staffName: string, reason: string): boolean {
  return staffName.trim().length > 0 && reason.trim().length > 0;
}
