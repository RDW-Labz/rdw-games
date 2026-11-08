'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { warehouseInputSchema } from '@auction-platform/shared/schemas';
import { Field, PageHeader, buttonStyle, inputStyle } from '@/components/Form';
import { createWarehouse } from './actions';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
  'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

export default function NewWarehousePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  // No default state: the warehouse state is the sales-tax jurisdiction for
  // in-person pickup (see lib/stripe-tax.ts buildPickupTaxShipping). A pre-
  // filled default would let an operator who skips this field create a
  // warehouse in the WRONG tax state. Force an explicit choice.
  const [stateCode, setStateCode] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parse = warehouseInputSchema.safeParse({
      name,
      addressLine1,
      addressLine2: addressLine2 || undefined,
      city,
      state: stateCode,
      postalCode,
      timezone,
    });
    if (!parse.success) {
      setError(parse.error.issues[0]?.message ?? 'Invalid input');
      return;
    }

    setLoading(true);
    const result = await createWarehouse(parse.data);
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/warehouses/${result.warehouseId}/bins`);
    router.refresh();
  }

  return (
    <div>
      <PageHeader title="New warehouse" />
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 540 }}>
        <Field label="Name (e.g., Cincinnati Main)">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Address line 1">
          <input style={inputStyle} value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} required />
        </Field>
        <Field label="Address line 2 (optional)">
          <input style={inputStyle} value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '1rem' }}>
          <Field label="City">
            <input style={inputStyle} value={city} onChange={(e) => setCity(e.target.value)} required />
          </Field>
          <Field label="State">
            <select
              style={inputStyle}
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
              required
            >
              <option value="" disabled>
                State…
              </option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ZIP">
            <input
              style={inputStyle}
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              required
            />
          </Field>
        </div>
        <Field label="Timezone" hint="IANA timezone, e.g. America/New_York or America/Los_Angeles">
          <input style={inputStyle} value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </Field>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div>
          <button type="submit" disabled={loading} style={buttonStyle}>
            {loading ? 'Creating…' : 'Create warehouse'}
          </button>
        </div>
      </form>
    </div>
  );
}
