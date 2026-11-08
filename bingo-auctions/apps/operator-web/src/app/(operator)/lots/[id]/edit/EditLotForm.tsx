'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents, formatCents } from '@auction-platform/shared';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { editLot } from '../actions';
import {
  joinLabels,
  lotEditPolicy,
  priceFieldsForFormat,
  PRICE_FIELD_LABELS,
} from './lot-edit-policy';

type Lot = {
  id: string;
  title: string;
  description: string;
  category: string;
  condition: 'appears_new' | 'open_box' | 'good' | 'as_is';
  msrp_cents: number | null;
  starting_bid_cents: number;
  flat_price_cents: number | null;
  dutch_start_cents: number | null;
  dutch_floor_cents: number | null;
  dutch_decline_per_minute_cents: number | null;
  bid_count: number;
  status: string;
  auction_id: string;
};

function fromCents(c: number | null): string {
  return c == null ? '' : (c / 100).toFixed(2);
}

export function EditLotForm({
  lot,
  format,
}: {
  lot: Lot;
  format: 'standard' | 'dutch' | 'last_chance';
}) {
  const router = useRouter();

  // Same rule the server applies (lot-edit-policy.ts): descriptive fields
  // always save; prices only while the lot has no bids and is pre-sale.
  const policy = lotEditPolicy({ status: lot.status, bidCount: lot.bid_count });
  const restrictFinancials = policy.pricesLocked;
  const lockedPriceLabels = priceFieldsForFormat(format).map((f) => PRICE_FIELD_LABELS[f]);
  const priceInputStyle: React.CSSProperties = restrictFinancials
    ? { ...inputStyle, opacity: 0.45, cursor: 'not-allowed' }
    : inputStyle;

  const [title, setTitle] = useState(lot.title);
  const [description, setDescription] = useState(lot.description);
  const [category, setCategory] = useState(lot.category);
  const [condition, setCondition] = useState(lot.condition);
  const [msrp, setMsrp] = useState(fromCents(lot.msrp_cents));
  const [startingBid, setStartingBid] = useState(fromCents(lot.starting_bid_cents));
  const [flatPrice, setFlatPrice] = useState(fromCents(lot.flat_price_cents));
  const [dutchStart, setDutchStart] = useState(fromCents(lot.dutch_start_cents));
  const [dutchFloor, setDutchFloor] = useState(fromCents(lot.dutch_floor_cents));
  const [dutchDeclinePerMin, setDutchDeclinePerMin] = useState(
    fromCents(lot.dutch_decline_per_minute_cents),
  );
  const [error, setError] = useState<string | null>(null);
  const [droppedNotice, setDroppedNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDroppedNotice(null);
    setSaving(true);
    try {
      const result = await editLot({
        lotId: lot.id,
        title,
        description: description || null,
        category: category || null,
        condition,
        msrpCents: msrp ? dollarsToCents(msrp) : null,
        startingBidCents: dollarsToCents(startingBid),
        flatPriceCents: flatPrice ? dollarsToCents(flatPrice) : null,
        dutchStartCents: dutchStart ? dollarsToCents(dutchStart) : null,
        dutchFloorCents: dutchFloor ? dollarsToCents(dutchFloor) : null,
        dutchDeclinePerMinuteCents: dutchDeclinePerMin
          ? dollarsToCents(dutchDeclinePerMin)
          : null,
      });
      if (!result.ok) {
        setError(result.error);
        setSaving(false);
        return;
      }
      if (result.dropped.length > 0) {
        // Never a silent partial save: say what was kept and what wasn't.
        setDroppedNotice(
          `Saved title, description, category and condition. Not saved: ${joinLabels(result.dropped)} — prices are locked because ${result.lockReason ?? 'the lot is past pre-sale'}.`,
        );
        setSaving(false);
        router.refresh();
        return;
      }
      router.push(`/lots/${lot.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 640 }}>
      {restrictFinancials && (
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
          Prices are locked because {policy.lockReason}: {joinLabels(lockedPriceLabels)} can&apos;t
          be changed. Title, description, category, condition and photos still save.
        </div>
      )}

      <Field label="Title">
        <input
          style={inputStyle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </Field>
      <Field label="Description">
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
        <Field label="Category">
          <input
            style={inputStyle}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
        <Field label="Condition">
          <select
            style={inputStyle}
            value={condition}
            onChange={(e) => setCondition(e.target.value as Lot['condition'])}
          >
            <option value="appears_new">Appears new</option>
            <option value="open_box">Open box</option>
            <option value="good">Good</option>
            <option value="as_is">As-is</option>
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field label="MSRP ($)" hint={restrictFinancials ? 'Locked' : 'Optional'}>
          <input
            style={priceInputStyle}
            type="number"
            step="0.01"
            value={msrp}
            onChange={(e) => setMsrp(e.target.value)}
            disabled={restrictFinancials}
          />
        </Field>
        <Field
          label="Starting bid ($)"
          hint={
            restrictFinancials
              ? `Locked — current ${formatCents(lot.starting_bid_cents)}`
              : undefined
          }
        >
          <input
            style={priceInputStyle}
            type="number"
            step="0.01"
            min="1"
            value={startingBid}
            onChange={(e) => setStartingBid(e.target.value)}
            required
            disabled={restrictFinancials}
          />
        </Field>
      </div>

      {format === 'last_chance' && (
        <Field label="Flat price ($)" hint={restrictFinancials ? 'Locked' : undefined}>
          <input
            style={priceInputStyle}
            type="number"
            step="0.01"
            min="1"
            value={flatPrice}
            onChange={(e) => setFlatPrice(e.target.value)}
            disabled={restrictFinancials}
          />
        </Field>
      )}

      {format === 'dutch' && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <Field label="Dutch start ($)" hint={restrictFinancials ? 'Locked' : undefined}>
              <input
                style={priceInputStyle}
                type="number"
                step="0.01"
                min="1"
                value={dutchStart}
                onChange={(e) => setDutchStart(e.target.value)}
                disabled={restrictFinancials}
              />
            </Field>
            <Field label="Dutch floor ($)" hint={restrictFinancials ? 'Locked' : undefined}>
              <input
                style={priceInputStyle}
                type="number"
                step="0.01"
                value={dutchFloor}
                onChange={(e) => setDutchFloor(e.target.value)}
                disabled={restrictFinancials}
              />
            </Field>
          </div>
          <Field label="Decline rate ($/min)" hint={restrictFinancials ? 'Locked' : undefined}>
            <input
              style={priceInputStyle}
              type="number"
              step="0.01"
              min="0.01"
              value={dutchDeclinePerMin}
              onChange={(e) => setDutchDeclinePerMin(e.target.value)}
              disabled={restrictFinancials}
            />
          </Field>
        </div>
      )}

      {droppedNotice && (
        <div role="status" style={{ color: '#ffb87a' }}>
          {droppedNotice}
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" disabled={saving} style={buttonStyle}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/lots/${lot.id}`)}
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
