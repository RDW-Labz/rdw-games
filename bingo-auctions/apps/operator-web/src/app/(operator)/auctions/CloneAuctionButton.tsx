'use client';

// Clone menu — duplicates an auction's settings into a new draft, shifted by
// a chosen offset, then lands on the new auction's edit page to tweak times
// before adding lots.
//
// 2026-07-04: was a single hardcoded "+7d" button (upstream's weekly-cadence
// mental model: "do what I did last Tuesday, for next Tuesday"). BinGo runs
// multiple auctions per day, and the fixed offset read as "the platform only
// allows one a day". The clone action always supported any offset
// (daysOffset 0–365) — this just exposes the useful ones. "Later today"
// clones with the SAME timestamps; the edit page it lands on is where the
// operator moves the times to the evening slot / next block.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cloneAuction } from './new/actions';

const OFFSETS: Array<{ days: number; label: string; hint: string }> = [
  { days: 0, label: 'Later today', hint: 'Same dates — adjust times on the edit page' },
  { days: 1, label: 'Tomorrow', hint: 'Everything shifted +1 day' },
  { days: 7, label: 'Next week', hint: 'Everything shifted +7 days' },
];

export function CloneAuctionButton({ auctionId }: { auctionId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);

  function onPick(days: number) {
    setOpen(false);
    start(async () => {
      const r = await cloneAuction({ sourceAuctionId: auctionId, daysOffset: days });
      if (!r.ok) {
        alert(`Clone failed: ${r.error}`);
        return;
      }
      router.push(`/auctions/${r.auctionId}/edit`);
    });
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        title="Duplicate this auction's settings into a new draft"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          padding: '4px 10px',
          background: 'transparent',
          color: 'var(--fg-muted)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: pending ? 'wait' : 'pointer',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {pending ? '…' : 'Clone ▾'}
      </button>
      {open && !pending && (
        <span
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 20,
            minWidth: 170,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          {OFFSETS.map((o) => (
            <button
              key={o.days}
              type="button"
              role="menuitem"
              onClick={() => onPick(o.days)}
              title={o.hint}
              style={{
                padding: '8px 12px',
                background: 'transparent',
                color: 'var(--fg)',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                textAlign: 'left',
              }}
            >
              {o.label}
              <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: 'var(--fg-muted)' }}>
                {o.hint}
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
