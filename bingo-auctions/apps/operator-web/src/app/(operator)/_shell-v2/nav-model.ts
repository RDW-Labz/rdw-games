// Console v2 shell — navigation model.
//
// MIRRORS the inline nav in ../layout.tsx (the v1 sidebar). v1's list is JSX,
// not a shared constant, and v1 output must not change, so the list is copied
// here. __tests__/shell-nav-parity.test.tsx renders the v1 layout for each role
// and fails if the hrefs, labels, groups, indent or role gating drift apart.
// Add or remove a nav entry in BOTH places. Growth (issue 930) is the exception:
// both shells read GROWTH_NAV_GROUP and insert it only when growthHubEnabled.

import { GROWTH_PAGES } from '@/lib/growth-hub';

export type ShellRole = 'admin' | 'manager';

export type ShellNavItem = {
  href: string;
  label: string;
  /** Indented child entry in v1 (paddingLeft 16, 13px muted). */
  sub?: boolean;
  /** Only these roles see the entry. Absent = every staff role. */
  roles?: readonly ShellRole[];
};

export type ShellNavGroup = {
  id: string;
  /** null = the unlabelled top group (Dashboard). */
  label: string | null;
  items: readonly ShellNavItem[];
};

const ADMIN_MANAGER: readonly ShellRole[] = ['admin', 'manager'];
const ADMIN_ONLY: readonly ShellRole[] = ['admin'];

export const GROWTH_NAV_GROUP: ShellNavGroup = {
  id: 'growth',
  label: 'Growth',
  items: GROWTH_PAGES.map((p) => ({
    href: p.href,
    label: p.label,
    sub: p.sub,
    roles: ADMIN_ONLY,
  })),
};

function groupsWithGrowth(
  groups: readonly ShellNavGroup[],
  growthHubEnabled: boolean,
): readonly ShellNavGroup[] {
  if (growthHubEnabled !== true) return groups;
  if (groups.some((g) => g.id === 'growth')) return groups;
  const i = groups.findIndex((g) => g.id === 'org');
  if (i < 0) return [...groups, GROWTH_NAV_GROUP];
  return [...groups.slice(0, i), GROWTH_NAV_GROUP, ...groups.slice(i)];
}

export const SHELL_NAV_GROUPS: readonly ShellNavGroup[] = [
  {
    id: 'home',
    label: null,
    items: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/dashboard/workers', label: 'Worker productivity', sub: true, roles: ['admin'] },
    ],
  },
  {
    id: 'auctions',
    label: 'Auctions',
    items: [{ href: '/auctions', label: 'Auctions' }],
  },
  {
    id: 'lotting',
    label: 'Lotting',
    items: [
      { href: '/lots/lookup', label: 'Lot lookup' },
      { href: '/lotting/inventory', label: 'Inventory' },
      { href: '/lotting/drafts', label: 'Drafts' },
      { href: '/imports/new', label: 'Import manifest', roles: ADMIN_MANAGER },
      { href: '/lotting/manifest-pool', label: 'Manifest pool' },
      { href: '/lotting/catalog', label: 'Catalog' },
      {
        href: '/imports/migrate',
        label: 'Migrate from another platform',
        sub: true,
        roles: ADMIN_MANAGER,
      },
      { href: '/loads', label: 'Loads' },
      { href: '/lottr', label: 'AI Lotting' },
    ],
  },
  {
    id: 'warehouses',
    label: 'Warehouses',
    items: [
      { href: '/warehouses', label: 'Warehouses' },
      { href: '/lotting/stickers', label: 'Print blank QR stickers', sub: true },
    ],
  },
  {
    id: 'pickup-issues',
    label: 'Pickup & issues',
    items: [
      { href: '/pickups', label: 'Pickups' },
      { href: '/disputes', label: 'Disputes' },
      { href: '/feedback', label: 'Feedback' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { href: '/invoices', label: 'Invoices' },
      { href: '/settlements', label: 'Settlements' },
    ],
  },
  {
    id: 'bidders-reports',
    label: 'Bidders & reports',
    items: [
      { href: '/bidders', label: 'Bidders' },
      { href: '/marketing', label: 'Marketing' },
      { href: '/reports', label: 'Reports' },
      { href: '/reports/money', label: 'Money & Square', sub: true },
      { href: '/reports/bidders', label: 'Bidders & retention', sub: true },
      { href: '/reports/bidder-zips', label: 'Bidders by ZIP', sub: true, roles: ADMIN_MANAGER },
      { href: '/reports/bidder-insights', label: 'Bidder insights', sub: true, roles: ADMIN_MANAGER },
      { href: '/reports/auctions', label: 'Auction performance', sub: true },
      { href: '/reports/health', label: 'Operations health', sub: true },
      { href: '/reports/aging', label: 'Aging inventory', sub: true },
      { href: '/reports/kept', label: 'Kept items', sub: true, roles: ADMIN_MANAGER },
      { href: '/reports/refund-overrides', label: 'Refund overrides', sub: true, roles: ADMIN_MANAGER },
      { href: '/reports/missing', label: 'Missing items', sub: true },
      { href: '/reports/duplicates', label: 'Duplicate audit', sub: true },
    ],
  },
  {
    id: 'org',
    label: 'Org',
    items: [
      { href: '/staff', label: 'Staff' },
      { href: '/settings', label: 'Settings' },
      { href: '/settings/policies', label: 'Policies', sub: true },
      { href: '/settings/bidder-experience', label: 'Bidder experience', sub: true },
      { href: '/settings/fulfillment', label: 'Fulfillment', sub: true },
    ],
  },
  {
    id: 'you',
    label: 'You',
    items: [
      { href: '/account', label: 'Account' },
      { href: '/account/security', label: 'Two-factor auth', sub: true },
      { href: '/account/policies', label: 'Bidder policies', sub: true },
    ],
  },
];

/** The groups and entries this role sees — same gating as v1's `role === …` checks. */
export function visibleNavGroups(
  role: string | null,
  groups: readonly ShellNavGroup[] = SHELL_NAV_GROUPS,
  opts: { growthHubEnabled?: boolean } = {},
): ShellNavGroup[] {
  return groupsWithGrowth(groups, opts.growthHubEnabled === true)
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (item) => !item.roles || (role !== null && (item.roles as readonly string[]).includes(role)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

// ── Stage hue for the active page ────────────────────────────────────────────

export type ShellStage = 'intake' | 'lotting' | 'auction' | 'paid' | 'pickup' | 'neutral';

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const STAGE_PREFIXES: ReadonlyArray<readonly [string, ShellStage]> = [
  ['/loads', 'intake'],
  ['/lotting/drafts', 'intake'],
  ['/lotting/inventory', 'lotting'],
  ['/lots', 'lotting'],
  ['/auctions', 'auction'],
  ['/invoices', 'paid'],
  ['/pickups', 'pickup'],
];

export function stageForPath(pathname: string | null | undefined): ShellStage {
  if (!pathname) return 'neutral';
  for (const [prefix, stage] of STAGE_PREFIXES) {
    if (under(pathname, prefix)) return stage;
  }
  return 'neutral';
}

export const STAGE_LABEL: Record<ShellStage, string | null> = {
  intake: 'Intake',
  lotting: 'Lotting',
  auction: 'Auction',
  paid: 'Paid',
  pickup: 'Pickup',
  neutral: null,
};

/** The nav href the current page belongs to: the longest entry the path sits under. */
export function activeNavHref(
  pathname: string | null | undefined,
  groups: readonly ShellNavGroup[],
): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const g of groups) {
    for (const item of g.items) {
      if (under(pathname, item.href) && (!best || item.href.length > best.length)) {
        best = item.href;
      }
    }
  }
  return best;
}

export type PageContext = { group: string | null; page: string };

/** Header "you are here": nav group + entry, else the stage name, else Console. */
export function pageContextFor(
  pathname: string | null | undefined,
  groups: readonly ShellNavGroup[],
): PageContext {
  const href = activeNavHref(pathname, groups);
  if (href) {
    for (const g of groups) {
      const item = g.items.find((i) => i.href === href);
      if (item) return { group: g.label, page: item.label };
    }
  }
  const stage = STAGE_LABEL[stageForPath(pathname)];
  return { group: null, page: stage ?? 'Console' };
}

// ── Collapsed groups, remembered per browser ────────────────────────────────

export const NAV_COLLAPSED_STORAGE_KEY = 'console-v2-shell-nav-collapsed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readCollapsedGroups(storage: StorageLike | null | undefined): string[] {
  try {
    const raw = storage?.getItem(NAV_COLLAPSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCollapsedGroups(
  storage: StorageLike | null | undefined,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(NAV_COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Private window / blocked storage: the nav still works, it just forgets.
  }
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/** Arrow Up/Down (wrapping), Home and End within the nav list. null = not ours. */
export function nextNavFocusIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function shouldCloseDrawer(key: string, drawerOpen: boolean): boolean {
  return drawerOpen && (key === 'Escape' || key === 'Esc');
}
