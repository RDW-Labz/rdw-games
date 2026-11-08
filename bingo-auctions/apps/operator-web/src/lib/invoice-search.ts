import type { SupabaseClient } from '@supabase/supabase-js';
import { lotCodeMatchFilters } from '@auction-platform/shared';
import { parseBidderSearch } from '@/app/(operator)/bidders/bidder-search';
import { findLotsByAnyCode, MAX_LINEAGE_HOPS } from '@/lib/lot-lineage';
import { sanitizePostgrestPattern } from '@/lib/postgrest-filter';

// 100 ids ≈ 3.7 KB in each query URL (the list and 6 tab counts all carry the
// filter); 200 risked proxy URL limits. Staff are told to narrow the search.
export const BIDDER_LIMIT = 100;
const IN_CHUNK = 100;

const FULL_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX8 = /^[0-9a-fA-F]{8}$/;
const BARE_DIGITS = /^(\d{1,9})$/;
const PHONEISH = /^[\d\s()\-+.]+$/;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedInvoiceSearch = {
  raw: string;
  invoiceId: string | null;
  idPrefix: string | null;
  bidderNumber: number | null;
  numberOnly: boolean;
  text: string | null;
  phoneDigits: string | null;
  lotCode: string | null;
};

const EMPTY_PARSED: Omit<ParsedInvoiceSearch, 'raw'> = {
  invoiceId: null,
  idPrefix: null,
  bidderNumber: null,
  numberOnly: false,
  text: null,
  phoneDigits: null,
  lotCode: null,
};

export function parseInvoiceSearch(q: string): ParsedInvoiceSearch {
  const raw = q.trim();
  if (!raw) return { raw: '', ...EMPTY_PARSED };

  if (FULL_UUID.test(raw)) {
    return { raw, ...EMPTY_PARSED, invoiceId: raw.toLowerCase() };
  }

  if (HEX8.test(raw)) {
    const p = raw.toLowerCase();
    return { raw, ...EMPTY_PARSED, idPrefix: p, text: raw };
  }

  const bidder = parseBidderSearch(raw);
  if (bidder.numberOnly && bidder.number !== null) {
    return {
      raw,
      ...EMPTY_PARSED,
      bidderNumber: bidder.number,
      numberOnly: true,
    };
  }

  const bare = BARE_DIGITS.exec(raw);
  if (bare) {
    const n = Number(bare[1]);
    const digits = bare[1]!;
    return {
      raw,
      ...EMPTY_PARSED,
      bidderNumber: n,
      phoneDigits: digits.length >= 4 ? digits : null,
    };
  }

  const trimmed = raw;
  let phoneDigits: string | null = null;
  if (PHONEISH.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 4) phoneDigits = digits;
  }

  let lotCode: string | null = null;
  if (
    trimmed.length >= 5 &&
    /[a-zA-Z]/.test(trimmed) &&
    /\d/.test(trimmed) &&
    lotCodeMatchFilters(trimmed) !== null
  ) {
    lotCode = trimmed;
  }

  return {
    raw,
    ...EMPTY_PARSED,
    text: trimmed,
    phoneDigits,
    lotCode,
  };
}

export function phoneIlikePattern(digits: string): string {
  return digits.split('').map((d) => `%${d}`).join('') + '%';
}

export function idPrefixRange(prefix8: string): [string, string] {
  const p = prefix8.toLowerCase();
  return [`${p}-0000-0000-0000-000000000000`, `${p}-ffff-ffff-ffff-ffffffffffff`];
}

export type InvoiceSearchScope = {
  invoiceIds: string[];
  bidderIds: string[];
  idRange: [string, string] | null;
  tooManyBidders: boolean;
  empty: boolean;
};

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function validUuid(id: string): boolean {
  return UUID_ONLY.test(id);
}

function scopeIsEmpty(s: {
  invoiceIds: string[];
  bidderIds: string[];
  idRange: [string, string] | null;
}): boolean {
  return s.invoiceIds.length === 0 && s.bidderIds.length === 0 && s.idRange === null;
}

const LOT_COLUMNS = 'id, lot_code, sticker_code, status, created_at, relisted_from_lot_id';

async function expandLotLineage(supabase: SupabaseClient, seedIds: string[]): Promise<string[]> {
  const all = new Set(seedIds);
  let frontier = [...seedIds];

  for (let hop = 0; hop < MAX_LINEAGE_HOPS && frontier.length > 0; hop++) {
    const next = new Set<string>();

    for (const ids of chunks(frontier, IN_CHUNK)) {
      const { data: rows } = await supabase
        .from('lots')
        .select('id, relisted_from_lot_id')
        .in('id', ids);
      for (const row of (rows ?? []) as { id: string; relisted_from_lot_id: string | null }[]) {
        const parent = row.relisted_from_lot_id;
        if (parent && !all.has(parent)) {
          next.add(parent);
          all.add(parent);
        }
      }
    }

    for (const ids of chunks(frontier, IN_CHUNK)) {
      const { data: children } = await supabase
        .from('lots')
        .select('id')
        .in('relisted_from_lot_id', ids)
        .is('deleted_at', null);
      for (const row of (children ?? []) as { id: string }[]) {
        if (!all.has(row.id)) {
          next.add(row.id);
          all.add(row.id);
        }
      }
    }

    frontier = [...next];
  }

  return [...all];
}

async function invoiceIdsForLots(supabase: SupabaseClient, lotIds: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const ids of chunks(lotIds, IN_CHUNK)) {
    const { data } = await supabase.from('invoice_lots').select('invoice_id').in('lot_id', ids);
    for (const row of (data ?? []) as { invoice_id: string }[]) {
      if (row.invoice_id) out.add(row.invoice_id);
    }
  }
  return [...out];
}

export function escapeLike(v: string): string {
  return v.replace(/\*/g, ' ').replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildBidderOrFilter(p: ParsedInvoiceSearch): string | null {
  const terms: string[] = [];
  if (p.bidderNumber !== null) {
    terms.push(`bidder_number.eq.${p.bidderNumber}`);
  }
  if (p.text) {
    // Structure chars out (security), then LIKE wildcards escaped so a typed
    // % _ or * matches itself instead of anything.
    const t = escapeLike(sanitizePostgrestPattern(p.text));
    terms.push(`display_name.ilike.%${t}%`);
    terms.push(`email.ilike.%${t}%`);
  }
  if (p.phoneDigits) {
    terms.push(`phone.ilike.${phoneIlikePattern(p.phoneDigits)}`);
  }
  return terms.length ? terms.join(',') : null;
}

export async function resolveInvoiceSearch(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  p: ParsedInvoiceSearch,
): Promise<InvoiceSearchScope> {
  if (p.invoiceId) {
    return {
      invoiceIds: [p.invoiceId],
      bidderIds: [],
      idRange: null,
      tooManyBidders: false,
      empty: false,
    };
  }

  const invoiceIdSet = new Set<string>();
  let idRange: [string, string] | null = null;
  let bidderIds: string[] = [];
  let tooManyBidders = false;

  if (p.idPrefix) {
    idRange = idPrefixRange(p.idPrefix);
  }

  if (p.numberOnly && p.bidderNumber !== null) {
    const { data } = await admin
      .from('bidders')
      .select('id')
      .is('deleted_at', null)
      .eq('bidder_number', p.bidderNumber)
      .limit(BIDDER_LIMIT);
    bidderIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
    tooManyBidders = bidderIds.length === BIDDER_LIMIT;
  } else {
    const orFilter = buildBidderOrFilter(p);
    if (orFilter) {
      const { data } = await admin
        .from('bidders')
        .select('id')
        .is('deleted_at', null)
        .or(orFilter)
        .limit(BIDDER_LIMIT);
      bidderIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
      tooManyBidders = bidderIds.length === BIDDER_LIMIT;
    }
  }

  if (p.lotCode) {
    const seeds = await findLotsByAnyCode(supabase, p.lotCode, LOT_COLUMNS);
    const seedIds = seeds.map((s) => s.id);
    if (seedIds.length > 0) {
      const allLotIds = await expandLotLineage(supabase, seedIds);
      const fromLots = await invoiceIdsForLots(supabase, allLotIds);
      for (const id of fromLots) invoiceIdSet.add(id);
    }
  }

  const invoiceIds = [...invoiceIdSet];
  const scope = { invoiceIds, bidderIds, idRange };
  return {
    ...scope,
    tooManyBidders,
    empty: scopeIsEmpty(scope),
  };
}

export function scopeOrFilter(s: InvoiceSearchScope): string | null {
  const parts: string[] = [];

  const ids = s.invoiceIds.filter(validUuid);
  for (const chunk of chunks(ids, IN_CHUNK)) {
    parts.push(`id.in.(${chunk.join(',')})`);
  }

  const bidders = s.bidderIds.filter(validUuid);
  for (const chunk of chunks(bidders, IN_CHUNK)) {
    parts.push(`bidder_id.in.(${chunk.join(',')})`);
  }

  if (s.idRange) {
    const [lo, hi] = s.idRange;
    if (validUuid(lo) && validUuid(hi)) {
      parts.push(`and(id.gte.${lo},id.lte.${hi})`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join(',');
}
