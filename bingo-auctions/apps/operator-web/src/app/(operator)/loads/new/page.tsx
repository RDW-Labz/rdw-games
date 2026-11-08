'use client';

// New manual load — manager-entered truck/pallet that didn't come from a
// CSV import. Submits to createManualLoad which RPCs create_manual_load
// (admin/manager only, enforced both at RLS and inside the RPC body).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field, PageHeader, buttonStyle, inputStyle } from '@/components/Form';
import { createManualLoad } from '../actions';

export default function NewManualLoadPage() {
  const router = useRouter();
  const [sourceName, setSourceName] = useState('');
  const [purchaseDollars, setPurchaseDollars] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let purchaseCostCents: number | null = null;
    if (purchaseDollars.trim() !== '') {
      const parsed = Number.parseFloat(purchaseDollars);
      if (Number.isNaN(parsed) || parsed < 0) {
        setError('Cost must be a non-negative dollar amount (e.g. 1200.50).');
        return;
      }
      // Round to nearest cent to avoid floating-point drift.
      purchaseCostCents = Math.round(parsed * 100);
    }

    setLoading(true);
    const result = await createManualLoad({
      sourceName: sourceName.trim(),
      purchaseCostCents,
      purchaseDate: purchaseDate || null,
      notes: notes.trim() || null,
    });
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push('/loads');
    router.refresh();
  }

  return (
    <div>
      <PageHeader title="New manual load" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 540, lineHeight: 1.5, marginBottom: 16 }}>
        Use this for trucks or pallets you bought without a manifest. For
        loads with a manifest, upload the CSV/XLSX in <a href="/imports/new" style={{ color: 'var(--accent)' }}>Import manifest</a> and a load row will be
        created automatically.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 540 }}>
        <Field label="Source name" hint="e.g. Amazon Returns Pallet 6/14, Truck 47L 5/9">
          <input
            style={inputStyle}
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            maxLength={200}
            required
            autoFocus
          />
        </Field>

        <Field label="Purchase cost (optional)" hint="USD, e.g. 1200.50">
          <input
            style={inputStyle}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={purchaseDollars}
            onChange={(e) => setPurchaseDollars(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label="Purchase date (optional)">
          <input
            style={inputStyle}
            type="date"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
          />
        </Field>

        <Field label="Notes (optional)" hint="Up to 2000 characters">
          <textarea
            style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit' }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={4}
          />
        </Field>

        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 12 }}>
          <button type="submit" disabled={loading} style={buttonStyle}>
            {loading ? 'Creating…' : 'Create load'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/loads')}
            disabled={loading}
            style={{
              ...buttonStyle,
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
