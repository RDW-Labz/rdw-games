'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BidIncrementTier } from '@auction-platform/shared';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import {
  BidIncrementScheduleEditor,
  parseDrafts,
  tiersToDrafts,
  type TierDraft,
} from '@/components/BidIncrementScheduleEditor';
import { editAuction } from '../../new/actions';

type Auction = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  /** May be null for legacy auctions created before migration 0053. */
  last_lot_ends_at: string | null;
  pickup_starts_at: string;
  pickup_ends_at: string;
  soft_close_minutes: number;
  prebid_enabled: boolean;
  buyer_premium_bps: number;
  format: 'standard' | 'dutch' | 'last_chance';
  /** BID-3: per-auction increment override. null = inherit operator default. */
  bid_increment_schedule: BidIncrementTier[] | null;
};

function toLocalInput(iso: string): string {
  // datetime-local wants 'YYYY-MM-DDTHH:mm' in the user's local time.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInputPlusMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EditAuctionForm({ auction }: { auction: Auction }) {
  const router = useRouter();

  const isScheduled = auction.status === 'scheduled';
  const locked = ['live', 'closed', 'canceled'].includes(auction.status);

  const [title, setTitle] = useState(auction.title);
  const [description, setDescription] = useState(auction.description ?? '');
  const [startsAt, setStartsAt] = useState(toLocalInput(auction.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(auction.ends_at));
  // Legacy auctions have null last_lot_ends_at — pre-fill with first
  // close + 90 min so the operator can opt into the windowed mode by
  // just clicking Save.
  const [lastLotEndsAt, setLastLotEndsAt] = useState(
    auction.last_lot_ends_at
      ? toLocalInput(auction.last_lot_ends_at)
      : toLocalInputPlusMinutes(auction.ends_at, 90),
  );
  const [pickupStartsAt, setPickupStartsAt] = useState(toLocalInput(auction.pickup_starts_at));
  const [pickupEndsAt, setPickupEndsAt] = useState(toLocalInput(auction.pickup_ends_at));
  const [softCloseMinutes, setSoftCloseMinutes] = useState(String(auction.soft_close_minutes));
  const [prebidEnabled, setPrebidEnabled] = useState(auction.prebid_enabled);
  const [buyerPremiumBps, setBuyerPremiumBps] = useState(String(auction.buyer_premium_bps));
  // BID-3: per-auction increment override (empty = inherit operator default).
  const [incrementDrafts, setIncrementDrafts] = useState<TierDraft[]>(
    tiersToDrafts(auction.bid_increment_schedule),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // BID-3: validate the override client-side. Empty = null = inherit default.
    const parsedSchedule = parseDrafts(incrementDrafts);
    if (!parsedSchedule.ok) {
      setError(parsedSchedule.error);
      return;
    }

    setSaving(true);
    const result = await editAuction({
      auctionId: auction.id,
      title,
      description: description || null,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      lastLotEndsAt: new Date(lastLotEndsAt).toISOString(),
      pickupStartsAt: new Date(pickupStartsAt).toISOString(),
      pickupEndsAt: new Date(pickupEndsAt).toISOString(),
      softCloseMinutes: Number(softCloseMinutes),
      prebidEnabled,
      buyerPremiumBps: Number(buyerPremiumBps),
      bidIncrementSchedule: parsedSchedule.tiers,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/auctions/${auction.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 640 }}>
      {locked && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 84, 112, 0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 6,
            color: 'var(--danger)',
            fontSize: 14,
          }}
        >
          {auction.status} auctions can&apos;t be edited.
        </div>
      )}
      {isScheduled && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 184, 122, 0.1)',
            border: '1px solid #ffb87a',
            borderRadius: 6,
            color: '#ffb87a',
            fontSize: 14,
          }}
        >
          Scheduled auction — you can extend (push out) close + pickup times and tweak soft-close
          minutes. Pulling in close times or changing the buyer premium isn&apos;t allowed once
          bidders can see the auction.
        </div>
      )}

      <Field label="Title">
        <input
          style={inputStyle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={locked}
          required
        />
      </Field>
      <Field label="Description">
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={locked}
        />
      </Field>
      <Field label="Format" hint="Locked — create a new auction to change format.">
        <input style={inputStyle} value={auction.format} disabled />
      </Field>
      <Field label="Bidding starts">
        <input
          style={inputStyle}
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          disabled={locked}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field
          label="First lot closes at"
          hint="Earliest lot close time. Was 'Bidding ends' on legacy auctions."
        >
          <input
            style={inputStyle}
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field
          label="Last lot closes at"
          hint="Spread close times across this window. Use the Redistribute button on the auction detail page after editing."
        >
          <input
            style={inputStyle}
            type="datetime-local"
            value={lastLotEndsAt}
            onChange={(e) => setLastLotEndsAt(e.target.value)}
            disabled={locked}
          />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field label="Pickup window starts">
          <input
            style={inputStyle}
            type="datetime-local"
            value={pickupStartsAt}
            onChange={(e) => setPickupStartsAt(e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field label="Pickup window ends">
          <input
            style={inputStyle}
            type="datetime-local"
            value={pickupEndsAt}
            onChange={(e) => setPickupEndsAt(e.target.value)}
            disabled={locked}
          />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field label="Soft-close minutes">
          <input
            style={inputStyle}
            type="number"
            min="0"
            max="30"
            value={softCloseMinutes}
            onChange={(e) => setSoftCloseMinutes(e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field
          label="Buyer's premium (bps)"
          hint={isScheduled ? 'Locked once scheduled' : '1500 = 15%'}
        >
          <input
            style={inputStyle}
            type="number"
            min="0"
            max="3000"
            value={buyerPremiumBps}
            onChange={(e) => setBuyerPremiumBps(e.target.value)}
            disabled={locked || isScheduled}
          />
        </Field>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={prebidEnabled}
          onChange={(e) => setPrebidEnabled(e.target.checked)}
          disabled={locked}
          style={{ marginTop: 2 }}
        />
        <span>
          <strong>Allow pre-bidding during preview</strong>
          <span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: 12 }}>
            Bidders can place max bids before the start time. Lots stay Upcoming and
            the anti-snipe clock only runs once the auction is live. Toggleable while
            draft or scheduled.
          </span>
        </span>
      </label>

      {/* BID-3 — per-auction increment override. Empty = inherit operator
          default. Editable while draft/scheduled (only raises the floor for
          future bids); locked on live/closed/canceled like the rest of the form. */}
      <BidIncrementScheduleEditor
        drafts={incrementDrafts}
        onChange={setIncrementDrafts}
        disabled={locked}
        label="Bid increment ladder (override, optional)"
        hint="Leave empty to inherit your operator default. Add tiers to override the minimum bid increment for this auction. First tier starts at $0.00."
        emptyHint="Inheriting your operator default ladder. Add tiers to override it for this auction."
      />
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" disabled={saving || locked} style={buttonStyle}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/auctions/${auction.id}`)}
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
