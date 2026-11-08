'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, Field } from '@/components/Form';
import { saveFulfillmentSettings } from './actions';

type Address = {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  phone?: string;
};

type Config = {
  returnAddress: Address | null;
  defaultPkgWeightOz: number;
  defaultPkgLengthIn: number;
  defaultPkgWidthIn: number;
  defaultPkgHeightIn: number;
  handlingFeeCents: number;
};

const EMPTY_ADDRESS: Address = {
  name: '',
  company: '',
  street1: '',
  street2: '',
  city: '',
  state: '',
  zip: '',
  country: 'US',
  phone: '',
};

export function FulfillmentForm({
  canEdit,
  operator,
  config,
}: {
  canEdit: boolean;
  operator: {
    id: string;
    businessName: string;
    offersPickup: boolean;
    offersShipping: boolean;
  };
  config: Config | null;
}) {
  const router = useRouter();
  const [offersPickup, setOffersPickup] = useState(operator.offersPickup);
  const [offersShipping, setOffersShipping] = useState(operator.offersShipping);
  const [addr, setAddr] = useState<Address>(config?.returnAddress ?? { ...EMPTY_ADDRESS, company: operator.businessName });
  const [pkgWeight, setPkgWeight] = useState(String(config?.defaultPkgWeightOz ?? 16));
  const [pkgLength, setPkgLength] = useState(String(config?.defaultPkgLengthIn ?? 12));
  const [pkgWidth, setPkgWidth] = useState(String(config?.defaultPkgWidthIn ?? 9));
  const [pkgHeight, setPkgHeight] = useState(String(config?.defaultPkgHeightIn ?? 3));
  const [handlingDollars, setHandlingDollars] = useState(
    ((config?.handlingFeeCents ?? 0) / 100).toFixed(2),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveFulfillmentSettings({
        offersPickup,
        offersShipping,
        returnAddress: offersShipping
          ? {
              name: addr.name?.trim() || undefined,
              company: addr.company?.trim() || undefined,
              street1: addr.street1.trim(),
              street2: addr.street2?.trim() || undefined,
              city: addr.city.trim(),
              state: addr.state.trim().toUpperCase(),
              zip: addr.zip.trim(),
              country: (addr.country || 'US').trim().toUpperCase(),
              phone: addr.phone?.trim() || undefined,
            }
          : undefined,
        defaultPkgWeightOz: Number(pkgWeight),
        defaultPkgLengthIn: Number(pkgLength),
        defaultPkgWidthIn: Number(pkgWidth),
        defaultPkgHeightIn: Number(pkgHeight),
        handlingFeeCents: Math.round(Number(handlingDollars) * 100),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1.5rem' }}>
      {/* Capability toggles */}
      <section
        style={{
          padding: '1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0, marginBottom: '0.75rem' }}>
          What this operator offers
        </h2>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.75rem',
            background: offersPickup ? 'var(--bg)' : 'transparent',
            border: `1px solid ${offersPickup ? 'var(--accent, #4f8cff)' : 'var(--border)'}`,
            borderRadius: 6,
            marginBottom: '0.5rem',
            cursor: canEdit ? 'pointer' : 'default',
          }}
        >
          <input
            type="checkbox"
            checked={offersPickup}
            onChange={(e) => setOffersPickup(e.target.checked)}
            disabled={!canEdit}
            style={{ marginTop: 2 }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>In-warehouse pickup</div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>
              Bidders collect items at one of your warehouses. Per-warehouse setup (hours, mode,
              floor plan) lives under each warehouse.
            </div>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.75rem',
            background: offersShipping ? 'var(--bg)' : 'transparent',
            border: `1px solid ${offersShipping ? 'var(--accent, #4f8cff)' : 'var(--border)'}`,
            borderRadius: 6,
            cursor: canEdit ? 'pointer' : 'default',
          }}
        >
          <input
            type="checkbox"
            checked={offersShipping}
            onChange={(e) => setOffersShipping(e.target.checked)}
            disabled={!canEdit}
            style={{ marginTop: 2 }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>Ship to bidder</div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>
              BinGo Auctions generates labels via EasyPost (USPS, UPS, FedEx). Bidder pays shipping at
              checkout. You print the label and drop the package with the carrier.
            </div>
          </div>
        </label>
      </section>

      {/* Shipping config — only relevant when shipping is on */}
      {offersShipping && (
        <section
          style={{
            padding: '1.25rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            display: 'grid',
            gap: '1rem',
          }}
        >
          <h2 style={{ fontSize: 16, margin: 0 }}>Return address</h2>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13 }}>
            Where every shipping label is printed FROM. Most operators use their warehouse
            address.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <Field label="Contact name">
              <input
                style={inputStyle}
                value={addr.name ?? ''}
                onChange={(e) => setAddr({ ...addr, name: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Company">
              <input
                style={inputStyle}
                value={addr.company ?? ''}
                onChange={(e) => setAddr({ ...addr, company: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
          </div>
          <Field label="Street address">
            <input
              style={inputStyle}
              value={addr.street1}
              onChange={(e) => setAddr({ ...addr, street1: e.target.value })}
              disabled={!canEdit}
              required={offersShipping}
            />
          </Field>
          <Field label="Suite / unit (optional)">
            <input
              style={inputStyle}
              value={addr.street2 ?? ''}
              onChange={(e) => setAddr({ ...addr, street2: e.target.value })}
              disabled={!canEdit}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
            <Field label="City">
              <input
                style={inputStyle}
                value={addr.city}
                onChange={(e) => setAddr({ ...addr, city: e.target.value })}
                disabled={!canEdit}
                required={offersShipping}
              />
            </Field>
            <Field label="State">
              <input
                style={inputStyle}
                value={addr.state}
                onChange={(e) => setAddr({ ...addr, state: e.target.value.toUpperCase() })}
                maxLength={2}
                disabled={!canEdit}
                required={offersShipping}
              />
            </Field>
            <Field label="ZIP">
              <input
                style={inputStyle}
                value={addr.zip}
                onChange={(e) => setAddr({ ...addr, zip: e.target.value })}
                disabled={!canEdit}
                required={offersShipping}
              />
            </Field>
          </div>
          <Field label="Phone (carriers may call for delivery questions)">
            <input
              style={inputStyle}
              value={addr.phone ?? ''}
              onChange={(e) => setAddr({ ...addr, phone: e.target.value })}
              disabled={!canEdit}
            />
          </Field>

          <h2 style={{ fontSize: 16, margin: 0, marginTop: '0.5rem' }}>Default package</h2>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13 }}>
            Used to quote shipping rates when an individual lot doesn&apos;t specify its own
            dimensions. Adjust toward your typical box.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
            <Field label="Weight (oz)">
              <input
                style={inputStyle}
                type="number"
                value={pkgWeight}
                onChange={(e) => setPkgWeight(e.target.value)}
                disabled={!canEdit}
                min={1}
                max={1120}
                required={offersShipping}
              />
            </Field>
            <Field label="Length (in)">
              <input
                style={inputStyle}
                type="number"
                value={pkgLength}
                onChange={(e) => setPkgLength(e.target.value)}
                disabled={!canEdit}
                min={1}
                max={108}
                step={0.5}
                required={offersShipping}
              />
            </Field>
            <Field label="Width (in)">
              <input
                style={inputStyle}
                type="number"
                value={pkgWidth}
                onChange={(e) => setPkgWidth(e.target.value)}
                disabled={!canEdit}
                min={1}
                max={108}
                step={0.5}
                required={offersShipping}
              />
            </Field>
            <Field label="Height (in)">
              <input
                style={inputStyle}
                type="number"
                value={pkgHeight}
                onChange={(e) => setPkgHeight(e.target.value)}
                disabled={!canEdit}
                min={1}
                max={108}
                step={0.5}
                required={offersShipping}
              />
            </Field>
          </div>

          <Field label="Handling fee (USD per shipment)">
            <input
              style={inputStyle}
              type="number"
              value={handlingDollars}
              onChange={(e) => setHandlingDollars(e.target.value)}
              disabled={!canEdit}
              min={0}
              max={500}
              step={0.01}
            />
          </Field>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 12 }}>
            Added on top of the carrier rate to cover packaging and labor. Bidder sees one total
            shipping number at checkout; this fee flows to you separately from the label cost.
          </p>
        </section>
      )}

      {error && (
        <div
          style={{
            padding: '0.75rem',
            background: 'rgba(248, 113, 113, 0.1)',
            border: '1px solid var(--danger, #f87171)',
            color: 'var(--danger, #f87171)',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="submit" disabled={!canEdit || pending} style={buttonStyle}>
          {pending ? 'Saving…' : 'Save fulfillment settings'}
        </button>
        {saved && (
          <span style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>✓ Saved</span>
        )}
      </div>
      {!canEdit && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Only operator admins can change these settings.
        </p>
      )}
    </form>
  );
}
