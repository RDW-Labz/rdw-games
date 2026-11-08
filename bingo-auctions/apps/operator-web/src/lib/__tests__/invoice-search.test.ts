import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const lotState = vi.hoisted(() => ({
  seeds: [] as Array<{ id: string; relisted_from_lot_id: string | null }>,
  lotsById: new Map<string, { id: string; relisted_from_lot_id: string | null }>(),
  childrenByParent: new Map<string, string[]>(),
  invoiceLots: [] as Array<{ lot_id: string; invoice_id: string }>,
}));

vi.mock('@/lib/lot-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lot-lineage')>();
  return {
    ...actual,
    findLotsByAnyCode: vi.fn(async () => lotState.seeds),
  };
});

import {
  parseInvoiceSearch,
  phoneIlikePattern,
  idPrefixRange,
  scopeOrFilter,
  resolveInvoiceSearch,
} from '../invoice-search';

// buildBidderOrFilter is not exported — test sanitization via resolve; export for test?
// Spec tests sanitization on .or() string — we'll capture via fake admin.

const FULL_INV = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('parseInvoiceSearch', () => {
  it('parses a full uuid', () => {
    const p = parseInvoiceSearch(FULL_INV);
    expect(p.invoiceId).toBe(FULL_INV.toLowerCase());
    expect(p.idPrefix).toBeNull();
    expect(p.bidderNumber).toBeNull();
    expect(p.lotCode).toBeNull();
  });

  it('parses an 8-hex prefix', () => {
    const p = parseInvoiceSearch('AbCd1234');
    expect(p.idPrefix).toBe('abcd1234');
    expect(p.text).toBe('AbCd1234');
    expect(p.invoiceId).toBeNull();
  });

  it('parses #2157 as bidder number only', () => {
    const p = parseInvoiceSearch('#2157');
    expect(p.bidderNumber).toBe(2157);
    expect(p.numberOnly).toBe(true);
    expect(p.text).toBeNull();
    expect(p.phoneDigits).toBeNull();
  });

  it('parses bare 2157', () => {
    const p = parseInvoiceSearch('2157');
    expect(p.bidderNumber).toBe(2157);
    expect(p.numberOnly).toBe(false);
    expect(p.phoneDigits).toBe('2157');
  });

  it('parses a formatted phone', () => {
    const p = parseInvoiceSearch('(870) 577-5971');
    expect(p.phoneDigits).toBe('8705775971');
    expect(p.text).toBe('(870) 577-5971');
  });

  it('parses email as text', () => {
    const p = parseInvoiceSearch('jane@x.com');
    expect(p.text).toBe('jane@x.com');
    expect(p.lotCode).toBeNull();
  });

  it('parses GRA4123327 as lot code', () => {
    const p = parseInvoiceSearch('GRA4123327');
    expect(p.lotCode).toBe('GRA4123327');
  });

  it('parses BIN-033361 as lot code', () => {
    const p = parseInvoiceSearch('BIN-033361');
    expect(p.lotCode).toBe('BIN-033361');
  });

  it('does not treat Jane as lot code', () => {
    const p = parseInvoiceSearch('Jane');
    expect(p.lotCode).toBeNull();
    expect(p.text).toBe('Jane');
  });
});

describe('phoneIlikePattern', () => {
  it('interleaves wildcards between digits', () => {
    expect(phoneIlikePattern('8705')).toBe('%8%7%0%5%');
  });
});

describe('idPrefixRange', () => {
  it('returns uuid bounds for the prefix', () => {
    expect(idPrefixRange('abcd1234')).toEqual([
      'abcd1234-0000-0000-0000-000000000000',
      'abcd1234-ffff-ffff-ffff-ffffffffffff',
    ]);
  });
});

describe('scopeOrFilter', () => {
  it('returns null when empty', () => {
    expect(
      scopeOrFilter({
        invoiceIds: [],
        bidderIds: [],
        idRange: null,
        tooManyBidders: false,
        empty: true,
      }),
    ).toBeNull();
  });

  it('combines invoice ids, bidder ids, and id range', () => {
    const inv = '11111111-1111-1111-1111-111111111111';
    const bid = '22222222-2222-2222-2222-222222222222';
    const f = scopeOrFilter({
      invoiceIds: [inv],
      bidderIds: [bid],
      idRange: idPrefixRange('aaaaaaaa'),
      tooManyBidders: false,
      empty: false,
    });
    expect(f).toContain(`id.in.(${inv})`);
    expect(f).toContain(`bidder_id.in.(${bid})`);
    expect(f).toContain('and(id.gte.aaaaaaaa-0000-0000-0000-000000000000,id.lte.aaaaaaaa-ffff-ffff-ffff-ffffffffffff)');
  });
});

type Captured = { table: string; or?: string; client: string };

function makeFakeClients(opts: {
  bidders?: { id: string }[];
  lots?: typeof lotState.lotsById;
  children?: typeof lotState.childrenByParent;
  invoiceLots?: typeof lotState.invoiceLots;
}) {
  const captured: Captured[] = [];

  function client(label: string): SupabaseClient {
    type Ctx = {
      table: string;
      lotIds?: string[];
      parentIds?: string[];
      invoiceLotIds?: string[];
    };
    const ctx: Ctx = { table: '' };

    const resolve = () => {
      if (ctx.table === 'bidders') {
        return { data: opts.bidders ?? [] };
      }
      if (ctx.table === 'lots') {
        if (ctx.lotIds) {
          const rows = ctx.lotIds
            .map((id) => opts.lots?.get(id))
            .filter(Boolean) as { id: string; relisted_from_lot_id: string | null }[];
          return { data: rows };
        }
        if (ctx.parentIds) {
          const rows: { id: string }[] = [];
          for (const pid of ctx.parentIds) {
            for (const kid of opts.children?.get(pid) ?? []) rows.push({ id: kid });
          }
          return { data: rows };
        }
      }
      if (ctx.table === 'invoice_lots' && ctx.invoiceLotIds) {
        const data = (opts.invoiceLots ?? []).filter((r) => ctx.invoiceLotIds!.includes(r.lot_id));
        return { data };
      }
      return { data: [] };
    };

    const b: Record<string, unknown> = {};
    const finish = () => Promise.resolve(resolve());

    b.from = (t: string) => {
      ctx.table = t;
      ctx.lotIds = undefined;
      ctx.parentIds = undefined;
      ctx.invoiceLotIds = undefined;
      return b;
    };
    b.select = () => b;
    b.is = () => b;
    b.eq = () => b;
    b.limit = finish;
    b.in = (col: string, vals: string[]) => {
      if (ctx.table === 'lots' && col === 'id') ctx.lotIds = vals;
      if (ctx.table === 'lots' && col === 'relisted_from_lot_id') ctx.parentIds = vals;
      if (ctx.table === 'invoice_lots' && col === 'lot_id') ctx.invoiceLotIds = vals;
      return b;
    };
    b.or = (filter: string) => {
      captured.push({ table: ctx.table, or: filter, client: label });
      return b;
    };
    (b as { then: Promise<unknown>['then'] }).then = (onfulfilled, onrejected) =>
      finish().then(onfulfilled, onrejected);

    return b as unknown as SupabaseClient;
  }

  return { user: client('user'), admin: client('admin'), captured };
}

describe('resolveInvoiceSearch', () => {
  beforeEach(() => {
    lotState.seeds = [];
    lotState.lotsById = new Map();
    lotState.childrenByParent = new Map();
    lotState.invoiceLots = [];
  });

  it('full invoice id returns invoiceIds without querying bidders or lots', async () => {
    const { user, admin, captured } = makeFakeClients({});
    const p = parseInvoiceSearch(FULL_INV);
    const scope = await resolveInvoiceSearch(user, admin, p);
    expect(scope.invoiceIds).toEqual([FULL_INV.toLowerCase()]);
    expect(scope.empty).toBe(false);
    expect(captured).toEqual([]);
  });

  it('bidder search uses the admin client (not the user client) and sets tooManyBidders at BIDDER_LIMIT (100)', async () => {
    const bidders = Array.from({ length: 100 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
    const { user, admin, captured } = makeFakeClients({ bidders });
    const p = parseInvoiceSearch('Jane');
    const scope = await resolveInvoiceSearch(user, admin, p);
    expect(scope.tooManyBidders).toBe(true);
    expect(captured.every((c) => c.client === 'admin')).toBe(true);
    expect(captured.some((c) => c.table === 'bidders')).toBe(true);
    expect(captured.some((c) => c.client === 'user')).toBe(false);
  });

  it('lot code search returns invoices on every lot in the relist lineage', async () => {
    const L1 = '10000000-0000-0000-0000-000000000001';
    const P1 = '10000000-0000-0000-0000-000000000002';
    const C1 = '10000000-0000-0000-0000-000000000003';
    const INV1 = '20000000-0000-0000-0000-000000000001';
    const INV2 = '20000000-0000-0000-0000-000000000002';
    const INV3 = '20000000-0000-0000-0000-000000000003';

    lotState.seeds = [{ id: L1, relisted_from_lot_id: P1 }];
    const lots = new Map([
      [L1, { id: L1, relisted_from_lot_id: P1 }],
      [P1, { id: P1, relisted_from_lot_id: null }],
    ]);
    const children = new Map([[L1, [C1]]]);
    const invoiceLots = [
      { lot_id: L1, invoice_id: INV1 },
      { lot_id: P1, invoice_id: INV2 },
      { lot_id: C1, invoice_id: INV3 },
    ];

    const { user, admin } = makeFakeClients({ lots, children, invoiceLots });
    const p = parseInvoiceSearch('GRA4123327');
    const scope = await resolveInvoiceSearch(user, admin, p);
    expect(scope.invoiceIds.sort()).toEqual([INV1, INV2, INV3].sort());
    expect(scope.empty).toBe(false);
  });
});

describe('bidder or-filter sanitization', () => {
  it('strips PostgREST metacharacters from user text in .or()', async () => {
    const { user, admin, captured } = makeFakeClients({ bidders: [] });
    const p = parseInvoiceSearch('x,id.not.is.null');
    await resolveInvoiceSearch(user, admin, p);
    const orCall = captured.find((c) => c.or);
    expect(orCall).toBeDefined();
    const or = orCall!.or!;
    for (const term of or.split(',')) {
      const m = term.match(/ilike\.%(.+)%$/);
      if (m) expect(m[1]).not.toMatch(/[,()|]/);
    }
    expect(or).toContain('display_name.ilike.%x id.not.is.null%');
  });
});

describe('escapeLike', () => {
  it('a typed % _ or * matches itself, not anything', async () => {
    const { escapeLike } = await import('../invoice-search');
    expect(escapeLike('a_b%c*d')).toBe('a\\_b\\%c d');
  });
});
