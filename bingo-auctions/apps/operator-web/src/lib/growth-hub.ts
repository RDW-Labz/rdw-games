// Growth hub shell (scope 10 / issue 930). Flag OFF by default; only true/1 enable.
// Importable from middleware: no React or server-only modules.

export const GROWTH_HUB_ENV = 'GROWTH_HUB_ENABLED';

export const GROWTH_REVENUE_SOURCES = [
  'handling_fee',
  'bidder_pass',
  'member_pro',
  'ad_subscription',
  'ad_boost',
] as const;

/** Documented existing average — not a live KPI and not an uplift factor. */
export const BINGO_AVERAGE_REVENUE_NOTE =
  'Feature revenue is compared to the documented BinGo average invoice total of $20,383 per week (11 full weeks, 2026-07-27 to 2026-10-11, Central; docs/state/revenue/baseline.md). Wallet loads are not revenue. No uplift or multiplier is applied. Times shown in Central (America/Chicago).';

export function isGrowthHubEnabled(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[GROWTH_HUB_ENV];
  return typeof raw === 'string' && (raw.trim().toLowerCase() === 'true' || raw.trim() === '1');
}

export function isGrowthHubConsoleRoute(pathname: string, enabled: boolean): boolean {
  return enabled === true && (pathname === '/growth' || pathname.startsWith('/growth/'));
}

export type GrowthPageId =
  | 'overview'
  | 'revenue'
  | 'memberships'
  | 'ads'
  | 'balances'
  | 'sneak-peek'
  | 'price-index'
  | 'sniper-protection'
  | 'swipe-feed'
  | 'change-log';

export type GrowthPageDef = {
  id: GrowthPageId;
  href: string;
  label: string;
  sub: boolean;
  kpiLabels: readonly string[];
  columns: readonly string[];
};

const OVERVIEW_KPIS = [
  'New-feature revenue',
  'Members by plan',
  'Active ads',
  'Wallet / credit held',
  'Trials started → converted',
] as const;
const SLOT_KPIS = ['This period', 'Last period', 'Status'] as const;
const MONTH_COLS = ['Metric', 'This month', 'Last month'] as const;

const LABELS: Record<GrowthPageId, string> = {
  overview: 'Overview',
  revenue: 'Revenue',
  memberships: 'Memberships',
  ads: 'Ads',
  balances: 'Balances',
  'sneak-peek': 'Sneak Peek',
  'price-index': 'Price Index',
  'sniper-protection': 'Sniper Protection',
  'swipe-feed': 'Swipe Feed',
  'change-log': 'Change Log',
};

export const GROWTH_PAGES: readonly GrowthPageDef[] = (
  Object.keys(LABELS) as GrowthPageId[]
).map((id) => ({
  id,
  href: id === 'overview' ? '/growth' : `/growth/${id}`,
  label: LABELS[id],
  sub: id !== 'overview',
  kpiLabels: id === 'overview' ? OVERVIEW_KPIS : SLOT_KPIS,
  columns:
    id === 'revenue'
      ? ['revenue_source', 'This period', 'Documented average']
      : id === 'change-log'
        ? ['When', 'Page', 'What', 'Why']
        : MONTH_COLS,
}));

export function growthPageBySlug(slug: string | undefined): GrowthPageDef | null {
  if (slug == null || slug === '' || slug === 'overview') return GROWTH_PAGES[0]!;
  return GROWTH_PAGES.find((p) => p.id === slug) ?? null;
}

export type GrowthAccess =
  | { ok: true; page: GrowthPageDef }
  | { ok: false; reason: 'disabled' | 'denied' | 'not_found' };

export function resolveGrowthAccess(input: {
  enabled: boolean;
  role: string | null | undefined;
  slug?: string;
  extraSegments?: number;
}): GrowthAccess {
  if (input.enabled !== true) return { ok: false, reason: 'disabled' };
  if ((input.extraSegments ?? 0) > 0) return { ok: false, reason: 'not_found' };
  const page = growthPageBySlug(input.slug);
  if (!page) return { ok: false, reason: 'not_found' };
  if (input.role !== 'admin') return { ok: false, reason: 'denied' };
  return { ok: true, page };
}

export type GrowthKpi = { label: string; value: string; sub?: string };
export type GrowthRow = Record<string, string>;
export type GrowthPageModel = {
  id: GrowthPageId; href: string; title: string; kpis: GrowthKpi[];
  columns: string[]; rows: GrowthRow[]; filter: string;
  filters: { value: string; label: string }[]; note: string;
};
export type GrowthAdapters = Partial<Record<GrowthPageId, { load: () => GrowthPageModel }>>;
export const GROWTH_ADAPTERS: GrowthAdapters = {};
export const GROWTH_FILTERS = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
] as const;

export function emptyGrowthModel(page: GrowthPageDef, filter = 'this-month'): GrowthPageModel {
  const active = GROWTH_FILTERS.some((f) => f.value === filter) ? filter : 'this-month';
  return {
    id: page.id, href: page.href, title: page.label, columns: [...page.columns], rows: [],
    filter: active, filters: GROWTH_FILTERS.map((f) => ({ value: f.value, label: f.label })),
    note: BINGO_AVERAGE_REVENUE_NOTE,
    kpis: page.kpiLabels.map((label) => ({ label, value: '—', sub: 'Waiting for this feature slice' })),
  };
}

export type GrowthPresentation =
  | { outcome: 'not_found' }
  | { outcome: 'denied'; title: string }
  | { outcome: 'retry'; title: string; message: string; retryHref: string }
  | { outcome: 'page'; model: GrowthPageModel; csv: string; dependencyMissing: boolean };

export function presentGrowthPage(input: {
  enabled: boolean; role: string | null | undefined; slug?: string;
  extraSegments?: number; filter?: string; adapters?: GrowthAdapters;
}): GrowthPresentation {
  const access = resolveGrowthAccess(input);
  if (!access.ok) {
    return access.reason === 'denied' ? { outcome: 'denied', title: 'Growth' } : { outcome: 'not_found' };
  }
  const adapter = (input.adapters ?? GROWTH_ADAPTERS)[access.page.id];
  if (!adapter) {
    const model = emptyGrowthModel(access.page, input.filter);
    return { outcome: 'page', model, csv: growthTableCsv(model.columns, model.rows), dependencyMissing: true };
  }
  try {
    const model = adapter.load();
    return { outcome: 'page', model, csv: growthTableCsv(model.columns, model.rows), dependencyMissing: false };
  } catch {
    return {
      outcome: 'retry', title: access.page.label,
      message: 'Could not load this page. Retry to try again.',
      retryHref: `${access.page.href}?retry=1`,
    };
  }
}

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function growthTableCsv(columns: readonly string[], rows: readonly GrowthRow[]): string {
  return [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((c) => csvCell(row[c] ?? '')).join(',')),
  ].join('\r\n');
}
