'use client';

// Filters for /reports/bidder-zips: ?location=<warehouse id> (absent = All),
// ?zip=<1–5 digit prefix>, and (mig 0438) ?state=<2 letters> + ?city=<name>.
// Keeps every other param (from/to), like ReportDateRange does. The state and
// city choices come from operator_bidder_places() (>= 3 bidders each); before
// 0438 they are not shown (the page's intro line says why).

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { secondaryButtonStyle } from '@/components/Form';
import { cityChoices, type PlaceOptions } from '@/lib/bidder-location';

const label: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  fontWeight: 700,
};

const input: React.CSSProperties = {
  padding: '0.35rem 0.5rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  fontSize: 13,
};

export function ZipFilters({
  locations,
  selectedId,
  zipPrefix,
  places,
}: {
  locations: Array<{ id: string; name: string; active: boolean }>;
  selectedId: string | null;
  zipPrefix: string | null;
  /** available=false before mig 0438. */
  places?: { available: boolean; state: string | null; city: string | null; options: PlaceOptions | null };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [zip, setZip] = useState(zipPrefix ?? '');

  const pushAll = (changes: Partial<Record<'location' | 'zip' | 'state' | 'city', string>>) => {
    const q = new URLSearchParams(params?.toString() ?? '');
    for (const [key, value] of Object.entries(changes)) {
      if (value) q.set(key, value);
      else q.delete(key);
    }
    const qs = q.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };
  const push = (key: 'location' | 'zip', value: string) => pushAll({ [key]: value });
  const cities = places?.available ? cityChoices(places.options, places.state, places.city) : [];
  const cityValue = cities.find((c) => c.value.toLowerCase() === (places?.city ?? '').toLowerCase())?.value ?? '';

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={label}>Auction location</span>
        <select value={selectedId ?? ''} onChange={(e) => push('location', e.target.value)} style={input}>
          <option value="">All locations</option>
          {locations
            .filter((l) => l.active || l.id === selectedId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.active ? '' : ' (inactive)'}
              </option>
            ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          push('zip', zip.trim());
        }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={label}>ZIP starts with</span>
          <input
            value={zip}
            onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            placeholder="e.g. 726"
            aria-label="ZIP prefix"
            style={{ ...input, width: 90 }}
          />
        </label>
        <button type="submit" style={secondaryButtonStyle}>
          Apply
        </button>
        {zipPrefix && (
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => {
              setZip('');
              push('zip', '');
            }}
          >
            Clear
          </button>
        )}
      </form>
      {places?.available ? (
        <>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={label}>State</span>
            <select
              value={places.state ?? ''}
              onChange={(e) => pushAll({ state: e.target.value, city: '' })}
              style={input}
              aria-label="State"
            >
              <option value="">All states</option>
              {(places.options?.states ?? []).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code}
                </option>
              ))}
              {places.state && !(places.options?.states ?? []).some((s) => s.code === places.state) && (
                <option value={places.state}>{places.state} (fewer than 3 bidders)</option>
              )}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={label}>City</span>
            <select
              value={cityValue}
              onChange={(e) => pushAll({ city: e.target.value })}
              disabled={!places.state}
              style={input}
              aria-label="City"
              title={places.state ? undefined : 'Pick a state first'}
            >
              <option value="">{places.state ? 'All cities' : 'Pick a state first'}</option>
              {cities.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null /* before 0438 the page's intro line says the filters need it */}
    </div>
  );
}
