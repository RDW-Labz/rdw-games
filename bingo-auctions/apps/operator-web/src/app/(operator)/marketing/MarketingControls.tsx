'use client';

// Interactive controls for /marketing: the auto toggle + "Send digest now"
// button with inline result feedback. Server work lives in actions.ts.

import { useState, useTransition } from 'react';
import {
  announceReferralProgram,
  sendDigestNow,
  setDigestAuto,
  setDigestLotCount,
  setSquareSetting,
} from './actions';

const LOT_COUNT_OPTIONS = [6, 9, 12, 18, 24];

export function MarketingControls({
  autoEnabled,
  previewCount,
  recipientCount,
  lotCount,
  squareSyncEnabled,
  squareLoyaltyEnabled,
}: {
  autoEnabled: boolean;
  previewCount: number;
  recipientCount: number;
  lotCount: number;
  squareSyncEnabled: boolean;
  squareLoyaltyEnabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [auto, setAuto] = useState(autoEnabled);
  const [count, setCount] = useState(lotCount);
  const [sqSync, setSqSync] = useState(squareSyncEnabled);
  const [sqLoyalty, setSqLoyalty] = useState(squareLoyaltyEnabled);

  const squareToggle = (
    key: 'square_sync_enabled' | 'square_loyalty_enabled',
    value: boolean,
    setLocal: (v: boolean) => void,
  ) => {
    setLocal(value);
    startTransition(async () => {
      const res = await setSquareSetting(key, value);
      if (!res.ok) setLocal(!value);
      setMessage({ ok: res.ok, text: res.message });
    });
  };

  const canSend = previewCount > 0 && recipientCount > 0;

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '1rem 1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={auto}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setAuto(next);
            startTransition(async () => {
              const res = await setDigestAuto(next);
              if (!res.ok) setAuto(!next);
              setMessage({ ok: res.ok, text: res.message });
            });
          }}
          style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
        />
        <div>
          <div style={{ fontWeight: 700 }}>Automatic digest</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            When ON: sends at ~9am on mornings an auction closes that day — never more than once
            per 72 hours, never on quiet days. When OFF: nothing sends unless you press the button.
          </div>
        </div>
      </label>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0.75rem 1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 10,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14 }}>Lots per digest</span>
        <select
          value={count}
          disabled={pending}
          onChange={(e) => {
            const next = Number(e.target.value);
            setCount(next);
            startTransition(async () => {
              const res = await setDigestLotCount(next);
              if (!res.ok) setCount(lotCount);
              setMessage({ ok: res.ok, text: res.message });
            });
          }}
          style={{
            padding: '0.45rem 0.7rem',
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          {LOT_COUNT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} lots
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Applies to manual sends and the automatic digest. Preview below updates on save.
        </span>
      </label>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '0.75rem',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '1rem 1.25rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={sqSync}
            disabled={pending}
            onChange={(e) => squareToggle('square_sync_enabled', e.target.checked, setSqSync)}
            style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--accent)' }}
          />
          <div>
            <div style={{ fontWeight: 700 }}>Square directory sync</div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              Every bidder becomes a Square customer in the &ldquo;BinGo Auction Bidders&rdquo;
              group — target them from Square Marketing next to your in-store customers.
            </div>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '1rem 1.25rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={sqLoyalty}
            disabled={pending}
            onChange={(e) => squareToggle('square_loyalty_enabled', e.target.checked, setSqLoyalty)}
            style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--accent)' }}
          />
          <div>
            <div style={{ fontWeight: 700 }}>Square Loyalty on auction purchases</div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              Paid auction invoices earn points in your existing Square Loyalty program (your
              program&rsquo;s earn rules apply; needs the bidder&rsquo;s phone number).
            </div>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !canSend}
          onClick={() =>
            startTransition(async () => {
              const res = await sendDigestNow();
              setMessage({ ok: res.ok, text: res.message });
            })
          }
          style={{
            padding: '0.75rem 1.5rem',
            fontSize: 15,
            cursor: pending || !canSend ? 'not-allowed' : 'pointer',
            opacity: pending || !canSend ? 0.55 : 1,
          }}
        >
          {pending ? 'Working…' : `Send digest now (${recipientCount} recipients)`}
        </button>
        {!canSend && (
          <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            {previewCount === 0
              ? 'Nothing closes in the next 48h — the button unlocks when lots are ending.'
              : 'No opted-in recipients.'}
          </span>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await announceReferralProgram();
              setMessage({ ok: res.ok, text: res.message });
            })
          }
          style={{ padding: '0.75rem 1.5rem', fontSize: 15, cursor: pending ? 'wait' : 'pointer' }}
        >
          Announce Give $5, get $5
        </button>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          One-time per bidder — each email contains their personal code. Safe to press again later;
          it only reaches new signups.
        </span>
      </div>

      {message && (
        <div
          style={{
            padding: '0.75rem 1rem',
            borderRadius: 8,
            fontSize: 14,
            background: message.ok ? 'rgba(34,197,94,0.08)' : 'rgba(240,180,40,0.08)',
            border: `1px solid ${message.ok ? 'rgba(34,197,94,0.4)' : 'rgba(240,180,40,0.4)'}`,
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
