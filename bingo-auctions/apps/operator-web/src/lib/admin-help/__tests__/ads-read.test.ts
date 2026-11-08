import { describe, expect, it } from 'vitest';
import { authorizeAdminHelpRead, isAdminHelpEnabled } from '@/lib/admin-help/flag';
import {
  ADS_READ_TOOLS,
  adminHelpRange,
  listAdsReadTools,
  missingAdsReadStore,
  runAdsReadTool,
  summarizeAdsBoostQueue,
  summarizeAdsImpressions,
  summarizeAdsPlacement,
  summarizeAdsRevenue,
  type AdsReadSnapshot,
  type AdsReadStore,
} from '@/lib/admin-help/ads-read';

const NOW = new Date('2026-11-03T18:00:00Z');
const ON = { ADMIN_HELP_ENABLED: 'true' };
const ADMIN = { surface: 'admin_console' as const, role: 'admin' };
const FLOOR = { surface: 'staff_help' as const, role: 'admin' };

const SNAPSHOT: AdsReadSnapshot = {
  revenue: [
    { occurred_at: '2026-11-03T12:00:00.000Z', source: 'ad_subscription', cents: 5000, tier: 'plus', business_key: 'biz-a' },
    { occurred_at: '2026-11-03T15:00:00.000Z', source: 'ad_boost', cents: 10000, tier: 'featured', business_key: 'biz-a' },
    { occurred_at: '2026-11-02T12:00:00.000Z', source: 'ad_subscription', cents: 3000, tier: 'basic', business_key: 'biz-b' },
  ],
  placements: [
    {
      ad_key: 'ad-1', business_key: 'biz-a', tier: 'plus', status: 'active',
      grid: true, search: true, lot_page: true, featured_rotation: false,
      active_from: '2026-11-01T00:00:00.000Z', active_to: null,
    },
    {
      ad_key: 'ad-2', business_key: 'biz-b', tier: 'featured', status: 'paused',
      grid: true, search: true, lot_page: true, featured_rotation: true,
      active_from: '2026-10-01T00:00:00.000Z', active_to: '2026-11-02T12:00:00.000Z',
    },
  ],
  events: [
    { occurred_at: '2026-11-03T12:00:00.000Z', kind: 'impression', viewer_key: 'v1' },
    { occurred_at: '2026-11-03T12:01:00.000Z', kind: 'impression', viewer_key: 'v1' },
    { occurred_at: '2026-11-03T12:02:00.000Z', kind: 'impression', viewer_key: 'v2' },
    { occurred_at: '2026-11-03T12:03:00.000Z', kind: 'tap', viewer_key: 'v2' },
    { occurred_at: '2026-11-02T12:00:00.000Z', kind: 'impression', viewer_key: 'v3' },
  ],
  boostQueue: {
    live_count: 1, waiting_count: 2, next_start_at: '2026-11-03T20:00:00.000Z',
    starts: [{ started_at: '2026-11-03T14:00:00.000Z' }, { started_at: '2026-11-02T14:00:00.000Z' }],
  },
};

const ready: AdsReadStore = { async load() { return SNAPSHOT; } };

function run(name: string, extra: Partial<Parameters<typeof runAdsReadTool>[0]> = {}) {
  return runAdsReadTool({
    name, caller: ADMIN, input: { range: 'today' }, store: ready, now: NOW, env: ON, retries: 0, ...extra,
  });
}

describe('Admin Help ads read tools', () => {
  it('flag is off unless env is the exact string true', () => {
    expect(isAdminHelpEnabled({})).toBe(false);
    expect(isAdminHelpEnabled({ ADMIN_HELP_ENABLED: 'false' })).toBe(false);
    expect(isAdminHelpEnabled({ ADMIN_HELP_ENABLED: 'TRUE' })).toBe(false);
    expect(isAdminHelpEnabled({ ADMIN_HELP_ENABLED: 'true' })).toBe(true);
  });

  it('disabled: no tools advertised and no data even with a snapshot', async () => {
    expect(listAdsReadTools(ADMIN, {})).toEqual([]);
    await expect(run('ads_revenue', { env: {} })).resolves.toEqual({ ok: false, error: 'disabled' });
  });

  it('denied: Staff Help stays out even if the session account is admin', async () => {
    expect(authorizeAdminHelpRead(FLOOR, ON)).toBe('denied');
    expect(listAdsReadTools(FLOOR, ON)).toEqual([]);
    await expect(run('ads_revenue', { caller: FLOOR })).resolves.toEqual({ ok: false, error: 'denied' });
  });

  it('denied: console manager cannot read ads totals', async () => {
    await expect(run('ads_impressions', { caller: { surface: 'admin_console', role: 'manager' } })).resolves.toEqual({
      ok: false, error: 'denied',
    });
  });

  it('dependency-missing: unavailable sources do not invent totals, including after retry', async () => {
    await expect(run('ads_revenue', { store: missingAdsReadStore })).resolves.toEqual({
      ok: false, error: 'dependency_missing',
    });
    await expect(run('ads_boost_queue', { store: missingAdsReadStore, retries: 1 })).resolves.toEqual({
      ok: false, error: 'dependency_missing',
    });
  });

  it('retries a transient load failure then returns Growth totals', async () => {
    let loads = 0;
    const store: AdsReadStore = {
      async load() {
        loads += 1;
        if (loads === 1) throw new Error('timeout');
        return SNAPSHOT;
      },
    };
    const result = await run('ads_revenue', { store, retries: 1 });
    expect(loads).toBe(2);
    expect(result).toMatchObject({ ok: true, data: { total_cents: 15000 } });
  });

  it('does not call the store when disabled or denied', async () => {
    let loads = 0;
    const store: AdsReadStore = { async load() { loads += 1; return SNAPSHOT; } };
    await run('ads_revenue', { store, env: {} });
    await run('ads_revenue', { store, caller: FLOOR });
    expect(loads).toBe(0);
  });

  it('enabled: Help totals match the Growth aggregators on the same snapshot', async () => {
    expect(listAdsReadTools(ADMIN, ON)).toEqual(ADS_READ_TOOLS);
    const bounds = adminHelpRange('today', NOW);
    expect('error' in bounds).toBe(false);
    if ('error' in bounds) return;

    const revenue = await run('ads_revenue');
    expect(revenue).toEqual({
      ok: true,
      data: { range: bounds.label, ...summarizeAdsRevenue(SNAPSHOT.revenue!, bounds.from, bounds.to) },
    });
    expect(revenue).toMatchObject({
      ok: true,
      data: {
        subscription_cents: 5000, boost_cents: 10000, total_cents: 15000, businesses: 1, charges: 2,
        by_tier_cents: { basic: 0, plus: 5000, featured: 10000 },
      },
    });

    const placement = await run('ads_placement');
    expect(placement).toEqual({
      ok: true,
      data: { range: bounds.label, ...summarizeAdsPlacement(SNAPSHOT.placements!, bounds.from, bounds.to) },
    });

    const impressions = await run('ads_impressions');
    expect(impressions).toEqual({
      ok: true,
      data: { range: bounds.label, ...summarizeAdsImpressions(SNAPSHOT.events!, bounds.from, bounds.to) },
    });
    expect(impressions).toMatchObject({ ok: true, data: { impressions: 3, unique_viewers: 2, taps: 1 } });

    const boost = await run('ads_boost_queue');
    expect(boost).toEqual({
      ok: true,
      data: { range: bounds.label, ...summarizeAdsBoostQueue(SNAPSHOT.boostQueue!, bounds.from, bounds.to) },
    });
    expect(boost).toMatchObject({ ok: true, data: { live: 1, waiting: 2, started_in_range: 1 } });
  });

  it('returns whitelist keys and integer cents, never opaque business keys', async () => {
    const result = await run('ads_revenue');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data).sort()).toEqual([
      'boost_cents', 'businesses', 'by_tier_cents', 'charges', 'range', 'subscription_cents', 'total_cents',
    ]);
    expect(Number.isInteger(result.data.total_cents)).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(/biz-/);
  });

  it('registers only the four read tools', () => {
    expect(ADS_READ_TOOLS.map((tool) => tool.name)).toEqual([
      'ads_revenue', 'ads_placement', 'ads_impressions', 'ads_boost_queue',
    ]);
    expect(ADS_READ_TOOLS.map((tool) => tool.name).join(',')).not.toMatch(/approve|pause|credit|bill|contact|email/);
  });

  it('uses the #713 America/Chicago day bounds', () => {
    expect(adminHelpRange('today', NOW)).toMatchObject({
      from: new Date('2026-11-03T06:00:00.000Z'),
      to: new Date('2026-11-04T06:00:00.000Z'),
    });
    expect(adminHelpRange('week', NOW)).toMatchObject({ from: new Date('2026-11-02T06:00:00.000Z') });
    expect(adminHelpRange('range', NOW, '2026-10-01', '2026-10-31')).toMatchObject({
      from: new Date('2026-10-01T05:00:00.000Z'),
      to: new Date('2026-11-01T05:00:00.000Z'),
    });
    expect(adminHelpRange('range', NOW)).toMatchObject({ error: 'range_from_to_required' });
    expect(adminHelpRange('range', NOW, '2024-01-01', '2026-11-01')).toMatchObject({ error: 'range_too_long' });
  });
});
