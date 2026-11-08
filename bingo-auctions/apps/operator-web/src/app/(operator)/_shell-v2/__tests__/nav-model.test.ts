import { describe, expect, it } from 'vitest';
import {
  GROWTH_NAV_GROUP,
  NAV_COLLAPSED_STORAGE_KEY,
  SHELL_NAV_GROUPS,
  activeNavHref,
  nextNavFocusIndex,
  pageContextFor,
  readCollapsedGroups,
  shouldCloseDrawer,
  stageForPath,
  visibleNavGroups,
  writeCollapsedGroups,
} from '../nav-model';

function hrefs(role: string | null, growthHubEnabled = false): string[] {
  return visibleNavGroups(role, SHELL_NAV_GROUPS, { growthHubEnabled }).flatMap((g) =>
    g.items.map((i) => i.href),
  );
}

describe('visibleNavGroups (role gating mirrors v1)', () => {
  it('admin sees worker productivity, import, migrate and kept items', () => {
    const h = hrefs('admin');
    for (const href of ['/dashboard/workers', '/imports/new', '/imports/migrate', '/reports/kept']) {
      expect(h).toContain(href);
    }
  });

  it('manager sees import/migrate/kept but not worker productivity', () => {
    const h = hrefs('manager');
    expect(h).not.toContain('/dashboard/workers');
    for (const href of ['/imports/new', '/imports/migrate', '/reports/kept']) expect(h).toContain(href);
  });

  it('other staff and a null role see none of the gated entries', () => {
    for (const role of ['staff', 'lotter', null]) {
      const h = hrefs(role);
      for (const href of ['/dashboard/workers', '/imports/new', '/imports/migrate', '/reports/kept']) {
        expect(h).not.toContain(href);
      }
      expect(h).toContain('/lotting/manifest-pool');
    }
  });

  it('Bidders by ZIP is admin/manager only (mig 0434)', () => {
    expect(hrefs('admin')).toContain('/reports/bidder-zips');
    expect(hrefs('manager')).toContain('/reports/bidder-zips');
    for (const role of ['staff', 'lotter', null]) expect(hrefs(role)).not.toContain('/reports/bidder-zips');
  });

  it('has unique hrefs and group ids', () => {
    const all = SHELL_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(all).size).toBe(all.length);
    const ids = SHELL_NAV_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Growth is fail-closed, admin-only, unique, and sits before Org', () => {
    expect(hrefs('admin')).not.toContain('/growth');
    const on = visibleNavGroups('admin', SHELL_NAV_GROUPS, { growthHubEnabled: true });
    const ids = on.map((g) => g.id);
    expect(ids.indexOf('growth')).toBeGreaterThan(-1);
    expect(ids.indexOf('growth')).toBeLessThan(ids.indexOf('org'));
    expect(hrefs('manager', true)).not.toContain('/growth');
    expect(activeNavHref('/growth/revenue', on)).toBe('/growth/revenue');
    const existing = new Set(SHELL_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
    const growth = GROWTH_NAV_GROUP.items.map((i) => i.href);
    expect(new Set(growth).size).toBe(growth.length);
    for (const href of growth) expect(existing.has(href)).toBe(false);
  });
});

describe('stageForPath', () => {
  it.each([
    ['/loads', 'intake'],
    ['/loads/abc', 'intake'],
    ['/lotting/drafts', 'intake'],
    ['/lotting/inventory', 'lotting'],
    ['/lots', 'lotting'],
    ['/lots/123', 'lotting'],
    ['/lots/lookup', 'lotting'],
    ['/auctions/9', 'auction'],
    ['/invoices', 'paid'],
    ['/pickups', 'pickup'],
    ['/dashboard', 'neutral'],
    ['/lotting/catalog', 'neutral'],
    ['/lotsx', 'neutral'],
    ['/pickupsfoo', 'neutral'],
    ['', 'neutral'],
  ])('%s → %s', (path, stage) => {
    expect(stageForPath(path)).toBe(stage);
  });
});

describe('activeNavHref / pageContextFor', () => {
  const groups = visibleNavGroups('admin');

  it('picks the longest matching entry', () => {
    expect(activeNavHref('/dashboard', groups)).toBe('/dashboard');
    expect(activeNavHref('/dashboard/workers', groups)).toBe('/dashboard/workers');
    expect(activeNavHref('/reports/money/2026', groups)).toBe('/reports/money');
    expect(activeNavHref('/pickups', groups)).toBe('/pickups');
  });

  it('does not match a sibling that only shares a prefix', () => {
    expect(activeNavHref('/accounting', groups)).toBeNull();
    expect(activeNavHref('/lots/abc', groups)).toBeNull();
  });

  it('a non-admin on /dashboard/workers falls back to Dashboard', () => {
    expect(activeNavHref('/dashboard/workers', visibleNavGroups('staff'))).toBe('/dashboard');
  });

  it('header context names the group and entry, else the stage', () => {
    expect(pageContextFor('/pickups', groups)).toEqual({ group: 'Pickup & issues', page: 'Pickups' });
    expect(pageContextFor('/dashboard', groups)).toEqual({ group: null, page: 'Dashboard' });
    expect(pageContextFor('/lots/abc', groups)).toEqual({ group: null, page: 'Lotting' });
    expect(pageContextFor('/nowhere', groups)).toEqual({ group: null, page: 'Console' });
  });
});

describe('collapsed-group storage', () => {
  function memoryStorage(initial?: string) {
    const map = new Map<string, string>();
    if (initial !== undefined) map.set(NAV_COLLAPSED_STORAGE_KEY, initial);
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it('round-trips ids', () => {
    const s = memoryStorage();
    writeCollapsedGroups(s, ['money', 'org']);
    expect(readCollapsedGroups(s)).toEqual(['money', 'org']);
  });

  it('ignores garbage and non-strings', () => {
    expect(readCollapsedGroups(memoryStorage('not json'))).toEqual([]);
    expect(readCollapsedGroups(memoryStorage('{"a":1}'))).toEqual([]);
    expect(readCollapsedGroups(memoryStorage('["org",3,null]'))).toEqual(['org']);
    expect(readCollapsedGroups(null)).toEqual([]);
  });

  it('never throws when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readCollapsedGroups(throwing)).toEqual([]);
    expect(() => writeCollapsedGroups(throwing, ['org'])).not.toThrow();
  });
});

describe('keyboard helpers', () => {
  it('ArrowDown / ArrowUp move and wrap', () => {
    expect(nextNavFocusIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextNavFocusIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextNavFocusIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextNavFocusIndex('ArrowUp', 2, 3)).toBe(1);
  });

  it('starts at an end when focus is not in the list', () => {
    expect(nextNavFocusIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextNavFocusIndex('ArrowUp', -1, 3)).toBe(2);
  });

  it('Home / End jump; other keys and empty lists are ignored', () => {
    expect(nextNavFocusIndex('Home', 2, 5)).toBe(0);
    expect(nextNavFocusIndex('End', 0, 5)).toBe(4);
    expect(nextNavFocusIndex('Tab', 0, 5)).toBeNull();
    expect(nextNavFocusIndex('ArrowLeft', 0, 5)).toBeNull();
    expect(nextNavFocusIndex('ArrowDown', 0, 0)).toBeNull();
  });

  it('Escape closes only an open drawer', () => {
    expect(shouldCloseDrawer('Escape', true)).toBe(true);
    expect(shouldCloseDrawer('Esc', true)).toBe(true);
    expect(shouldCloseDrawer('Escape', false)).toBe(false);
    expect(shouldCloseDrawer('Enter', true)).toBe(false);
  });
});
