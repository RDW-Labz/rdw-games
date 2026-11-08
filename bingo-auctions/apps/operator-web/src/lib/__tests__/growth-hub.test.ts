import { describe, expect, it } from 'vitest';
import {
  BINGO_AVERAGE_REVENUE_NOTE,
  GROWTH_ADAPTERS,
  GROWTH_PAGES,
  GROWTH_REVENUE_SOURCES,
  csvCell,
  emptyGrowthModel,
  growthPageBySlug,
  growthTableCsv,
  isGrowthHubConsoleRoute,
  isGrowthHubEnabled,
  presentGrowthPage,
  resolveGrowthAccess,
  type GrowthPageModel,
} from '../growth-hub';

const admin = { enabled: true, role: 'admin' as const };

function syntheticOverview(): GrowthPageModel {
  return {
    ...emptyGrowthModel(growthPageBySlug('overview')!),
    kpis: [{ label: 'New-feature revenue', value: '$0.00', sub: '0 cents tagged' }],
    rows: [{ Metric: 'handling_fee', 'This month': '0', 'Last month': '0' }],
  };
}

describe('growth hub flag, access, load, csv', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['yes', false],
    ['on', false],
    ['trueish', false],
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
  ])('flag %j → %s', (raw, expected) => {
    expect(isGrowthHubEnabled(raw === undefined ? {} : { GROWTH_HUB_ENABLED: raw })).toBe(expected);
  });

  it('flag-off /growth is not an operator prefix; flag-on is', () => {
    expect(isGrowthHubConsoleRoute('/growth', false)).toBe(false);
    expect(isGrowthHubConsoleRoute('/growth/revenue', true)).toBe(true);
    expect(isGrowthHubConsoleRoute('/dashboard', true)).toBe(false);
    expect(isGrowthHubConsoleRoute('/growthx', true)).toBe(false);
  });

  it('disabled, denied, not_found, enabled', () => {
    expect(resolveGrowthAccess({ enabled: false, role: 'admin' })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    for (const role of ['manager', 'staff', null]) {
      expect(resolveGrowthAccess({ enabled: true, role })).toEqual({ ok: false, reason: 'denied' });
    }
    expect(resolveGrowthAccess({ ...admin, slug: 'nope' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(resolveGrowthAccess({ ...admin, slug: 'revenue', extraSegments: 1 })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(resolveGrowthAccess({ ...admin }).ok).toBe(true);
    expect(resolveGrowthAccess({ ...admin, slug: 'revenue' }).ok).toBe(true);
  });

  it('disabled presents as not_found so today’s route stays gone', () => {
    expect(presentGrowthPage({ enabled: false, role: 'admin' }).outcome).toBe('not_found');
  });

  it('denied', () => {
    expect(presentGrowthPage({ enabled: true, role: 'manager' }).outcome).toBe('denied');
  });

  it('dependency-missing: blank KPIs, documented average in the note only', () => {
    expect(Object.keys(GROWTH_ADAPTERS)).toHaveLength(0);
    const view = presentGrowthPage({ ...admin, filter: 'nope' });
    if (view.outcome !== 'page') throw new Error(view.outcome);
    expect(view.dependencyMissing).toBe(true);
    expect(view.model.filter).toBe('this-month');
    expect(view.model.kpis.every((k) => k.value === '—')).toBe(true);
    expect(view.model.rows).toEqual([]);
    expect(view.model.note).toBe(BINGO_AVERAGE_REVENUE_NOTE);
    expect(view.csv).toBe('Metric,This month,Last month');
  });

  it('enabled synthetic adapter uses that data', () => {
    const view = presentGrowthPage({ ...admin, adapters: { overview: { load: syntheticOverview } } });
    if (view.outcome !== 'page') throw new Error(view.outcome);
    expect(view.dependencyMissing).toBe(false);
    expect(view.model.kpis[0]?.value).toBe('$0.00');
    expect(view.csv).toContain('handling_fee');
  });

  it('retry: throwing adapter then succeeds', () => {
    let n = 0;
    const adapters = {
      overview: {
        load: () => {
          n += 1;
          if (n === 1) throw new Error('transient');
          return syntheticOverview();
        },
      },
    };
    const first = presentGrowthPage({ ...admin, adapters });
    expect(first).toMatchObject({ outcome: 'retry', retryHref: '/growth?retry=1' });
    expect(presentGrowthPage({ ...admin, adapters }).outcome).toBe('page');
  });

  it('wallet loads are not revenue; ten unique slots; csv escapes', () => {
    expect([...GROWTH_REVENUE_SOURCES]).toEqual([
      'handling_fee',
      'bidder_pass',
      'member_pro',
      'ad_subscription',
      'ad_boost',
    ]);
    expect(GROWTH_PAGES).toHaveLength(10);
    expect(new Set(GROWTH_PAGES.map((p) => p.href)).size).toBe(10);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(growthTableCsv(['A'], [{ A: 'say "hi"' }])).toBe('A\r\n"say ""hi"""');
  });
});
