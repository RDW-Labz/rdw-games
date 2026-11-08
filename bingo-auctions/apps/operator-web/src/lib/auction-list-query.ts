import { sanitizePostgrestPattern } from '@/lib/postgrest-filter';

export const AUCTION_PAGE_SIZE = 50;

export type AuctionStatusTab = 'all' | 'draft' | 'scheduled' | 'live' | 'closed' | 'canceled';

const VALID_STATUS_TABS = new Set<AuctionStatusTab>([
  'all',
  'draft',
  'scheduled',
  'live',
  'closed',
  'canceled',
]);

function firstParam(v?: string | string[]): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function parseAuctionListParams(sp: {
  q?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): { q: string; status: AuctionStatusTab; page: number } {
  const q = (firstParam(sp.q) ?? '').trim().slice(0, 100);

  const rawStatus = firstParam(sp.status) ?? 'all';
  const status = VALID_STATUS_TABS.has(rawStatus as AuctionStatusTab)
    ? (rawStatus as AuctionStatusTab)
    : 'all';

  const rawPage = firstParam(sp.page);
  let page = 1;
  if (rawPage !== undefined) {
    const n = Number.parseInt(rawPage, 10);
    if (Number.isFinite(n) && n >= 1) page = n;
  }

  return { q, status, page };
}

function escapeIlikeMetacharacters(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Pattern for `.ilike('title', pattern)` — not for use inside `.or()`. */
export function titleIlikePattern(q: string): string | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;

  let escaped = sanitizePostgrestPattern(trimmed);
  escaped = escaped.replace(/\*/g, ' ');
  escaped = escapeIlikeMetacharacters(escaped);
  return `%${escaped}%`;
}

export function auctionListHref(p: {
  q: string;
  status: AuctionStatusTab;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (p.q) params.set('q', p.q);
  if (p.status !== 'all') params.set('status', p.status);
  const page = p.page ?? 1;
  if (page !== 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/auctions?${qs}` : '/auctions';
}

export function pageRange(page: number): [number, number] {
  const start = (page - 1) * AUCTION_PAGE_SIZE;
  const end = page * AUCTION_PAGE_SIZE - 1;
  return [start, end];
}
