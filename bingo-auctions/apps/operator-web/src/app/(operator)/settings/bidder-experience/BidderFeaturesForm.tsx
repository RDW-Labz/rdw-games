'use client';

import { useState, useTransition } from 'react';
import {
  FEATURE_CATALOG,
  type BidderFeatures,
  type FeatureKey,
  type FlagValue,
} from '@auction-platform/shared/features';
import { saveBidderFeatures } from './actions';
import { buttonStyle } from '@/components/Form';

const VALUES: Array<{ value: FlagValue; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'Hidden entirely' },
  { value: 'all', label: 'All', hint: 'Every bidder' },
  { value: 'pro', label: 'Pro', hint: 'Subscribers only' },
];

const GROUP_LABELS: Record<string, string> = {
  search: 'Search & filter',
  sort: 'Sort options',
  discovery: 'Discovery & convenience',
};

const PRESETS: Array<{ label: string; description: string; apply: () => BidderFeatures }> = [
  {
    label: 'Calm storefront',
    description: 'Search + ending-soon + newest. Everything else off.',
    apply: () => ({
      search_bar: 'all',
      sort_ending_soon: 'all',
      sort_newest: 'all',
    }),
  },
  {
    label: 'Power buyer (free)',
    description: 'Every search, sort, and filter on for everyone.',
    apply: () => {
      const out: BidderFeatures = {};
      for (const f of FEATURE_CATALOG) out[f.key] = 'all';
      return out;
    },
  },
  {
    label: 'Pro-tier bundle',
    description: 'Basics free; advanced sorts + saved searches + featured deals locked to Pro.',
    apply: () => ({
      // Free
      search_bar: 'all',
      category_filter: 'all',
      condition_filter: 'all',
      multi_warehouse: 'all',
      recently_viewed: 'all',
      sort_ending_soon: 'all',
      sort_newest: 'all',
      // Pro
      msrp_discount_filter: 'pro',
      sort_highest_bid: 'pro',
      sort_most_bids: 'pro',
      sort_biggest_discount: 'pro',
      sort_low_to_high_price: 'pro',
      saved_searches: 'pro',
      category_subscriptions: 'pro',
      featured_deals: 'pro',
      compare_lots: 'pro',
      operator_follow: 'pro',
    }),
  },
];

export function BidderFeaturesForm({
  canEdit,
  initial,
}: {
  canEdit: boolean;
  initial: BidderFeatures;
}) {
  const [features, setFeatures] = useState<BidderFeatures>(initial);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setFlag(key: FeatureKey, value: FlagValue) {
    setFeatures((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  }

  function applyPreset(preset: BidderFeatures) {
    setFeatures({ ...preset });
    setSavedAt(null);
  }

  function onSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveBidderFeatures(features);
      if (!result.ok) setError(result.error);
      else setSavedAt(Date.now());
    });
  }

  // Group features for display.
  const grouped = new Map<string, typeof FEATURE_CATALOG>();
  for (const f of FEATURE_CATALOG) {
    if (!grouped.has(f.group)) grouped.set(f.group, []);
    grouped.get(f.group)!.push(f);
  }

  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 24 }}>
      {/* Presets */}
      <section
        style={{
          padding: 14,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 8 }}>
          Quick presets
        </div>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={!canEdit}
              onClick={() => applyPreset(p.apply())}
              style={{
                textAlign: 'left',
                padding: 12,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--fg)',
                cursor: canEdit ? 'pointer' : 'not-allowed',
                opacity: canEdit ? 1 : 0.6,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.label}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                {p.description}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Per-feature radios, grouped */}
      {Array.from(grouped.entries()).map(([group, items]) => (
        <section key={group}>
          <h3
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              margin: '0 0 12px',
            }}
          >
            {GROUP_LABELS[group] ?? group}
          </h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((f) => {
              const current: FlagValue = features[f.key] ?? 'off';
              return (
                <div
                  key={f.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: 12,
                    padding: '12px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{f.label}</div>
                    <div
                      style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}
                    >
                      {f.description}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {VALUES.map((v) => {
                      const active = current === v.value;
                      return (
                        <button
                          key={v.value}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => setFlag(f.key, v.value)}
                          title={v.hint}
                          style={{
                            padding: '6px 14px',
                            border: '1px solid',
                            borderColor: active ? 'var(--accent)' : 'var(--border)',
                            background: active ? 'var(--accent-dim)' : 'transparent',
                            color: active ? 'var(--accent)' : 'var(--fg-muted)',
                            borderRadius: 999,
                            fontWeight: 700,
                            fontSize: 12,
                            cursor: canEdit ? 'pointer' : 'not-allowed',
                            letterSpacing: 0.4,
                          }}
                        >
                          {v.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Save row */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--bg)',
          padding: '12px 0',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={onSave}
          disabled={!canEdit || pending}
          style={{
            ...buttonStyle,
            color: '#000',
            fontWeight: 800,
            opacity: !canEdit || pending ? 0.5 : 1,
          }}
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {savedAt && !error && (
          <span style={{ color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>
            Saved
          </span>
        )}
        {error && (
          <span style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 600 }}>{error}</span>
        )}
        {!canEdit && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Admins only.</span>
        )}
      </div>
    </div>
  );
}
