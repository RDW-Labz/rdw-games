'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, secondaryButtonStyle, inputStyle } from '@/components/Form';
import { suspendBidder, unsuspendBidder, saveNote, waiveBidderFees } from '../actions';

export function BidderActions({
  bidderId,
  isSuspended,
  suspendedReason,
  currentNotes,
  canManage,
  unpaidFeesCents,
  isAdmin,
}: {
  bidderId: string;
  isSuspended: boolean;
  suspendedReason: string | null;
  currentNotes: string | null;
  canManage: boolean;
  unpaidFeesCents: number;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState(currentNotes ?? '');
  const [showSuspend, setShowSuspend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notesSaved, setNotesSaved] = useState(false);
  const [waiveReason, setWaiveReason] = useState('');
  const [showWaive, setShowWaive] = useState(false);

  function handleWaive() {
    startTransition(async () => {
      try {
        await waiveBidderFees(bidderId, waiveReason);
        setShowWaive(false);
        setWaiveReason('');
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed');
      }
    });
  }

  if (!canManage) return null;

  function handleSuspend() {
    startTransition(async () => {
      try {
        await suspendBidder(bidderId, reason);
        setShowSuspend(false);
        setReason('');
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed');
      }
    });
  }

  function handleUnsuspend() {
    startTransition(async () => {
      try {
        await unsuspendBidder(bidderId);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed');
      }
    });
  }

  function handleSaveNote() {
    startTransition(async () => {
      try {
        await saveNote(bidderId, notes);
        setNotesSaved(true);
        setTimeout(() => setNotesSaved(false), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed');
      }
    });
  }

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      {error && (
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      )}

      {/* Internal notes */}
      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.95rem' }}>Internal notes</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Private notes visible only to your staff..."
          style={{
            ...inputStyle,
            width: '100%',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <button
          onClick={handleSaveNote}
          disabled={pending}
          style={{ ...buttonStyle, marginTop: '0.5rem' }}
        >
          {notesSaved ? 'Saved' : pending ? 'Saving…' : 'Save notes'}
        </button>
      </section>

      {/* Unpaid relot fees — this is what actually blocks bidding (place_bid
          refuses while unpaid_fees_cents > 0), so waiving it IS the unblock. */}
      {unpaidFeesCents > 0 && (
        <section
          style={{
            padding: '1rem',
            background: 'var(--bg-elev)',
            border: '1px solid rgba(255,84,112,0.4)',
            borderRadius: 6,
          }}
        >
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
            Blocked from bidding — ${(unpaidFeesCents / 100).toFixed(2)} in unpaid fees
          </h3>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>
            Waive if the charge failed for a reason outside the bidder&rsquo;s control
            (upstream payment outage, our error). If their card genuinely declined,
            leave it and let them settle on the Pay Fees page.
          </p>
          {!isAdmin ? (
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
              Admin only — ask an admin to waive.
            </p>
          ) : showWaive ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <input
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="Reason (recorded on the fee ledger)"
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={handleWaive} disabled={pending} style={buttonStyle}>
                  {pending ? 'Waiving…' : `Confirm waive $${(unpaidFeesCents / 100).toFixed(2)}`}
                </button>
                <button onClick={() => setShowWaive(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowWaive(true)} style={buttonStyle}>
              Waive fees &amp; unblock
            </button>
          )}
        </section>
      )}

      {/* Suspend / unsuspend */}
      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: `1px solid ${isSuspended ? 'rgba(255,84,112,0.4)' : 'var(--border)'}`,
          borderRadius: 6,
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
          {isSuspended ? 'Bidder suspended' : 'Suspension'}
        </h3>
        {isSuspended && suspendedReason && (
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>
            Reason: {suspendedReason}
          </p>
        )}
        {isSuspended ? (
          <button onClick={handleUnsuspend} disabled={pending} style={secondaryButtonStyle}>
            {pending ? 'Lifting…' : 'Lift suspension'}
          </button>
        ) : showSuspend ? (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleSuspend}
                disabled={pending}
                style={{ ...buttonStyle, background: 'var(--danger)' }}
              >
                {pending ? 'Suspending…' : 'Confirm suspend'}
              </button>
              <button onClick={() => setShowSuspend(false)} style={secondaryButtonStyle}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowSuspend(true)}
            style={{ ...secondaryButtonStyle, color: 'var(--danger)', borderColor: 'rgba(255,84,112,0.4)' }}
          >
            Suspend this bidder
          </button>
        )}
      </section>
    </div>
  );
}
