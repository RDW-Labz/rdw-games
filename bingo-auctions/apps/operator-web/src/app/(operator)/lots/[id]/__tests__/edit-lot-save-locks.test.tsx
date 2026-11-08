// Console lot editor (2026-10-13, Jared on the floor: "edits won't save").
// The form and the editLot action disagreed about what may change, and the
// action returned OK while dropping fields. Both now use lotEditPolicy:
//   1. scheduled, no bids  -> everything saves, prices included;
//   2. live or has bids    -> title/description/category/condition save,
//                             prices locked, greyed out and named;
//   3. never a silent drop -> a locked price sent with a new value comes back
//                             in `dropped`, and a 0-row update is an error.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

type LotRow = {
  status: string;
  bid_count: number;
  operator_id: string;
  msrp_cents: number | null;
  starting_bid_cents: number;
  flat_price_cents: number | null;
  dutch_start_cents: number | null;
  dutch_floor_cents: number | null;
  dutch_decline_per_minute_cents: number | null;
};

const state = vi.hoisted(() => ({
  lot: null as unknown as LotRow,
  updates: [] as Array<Record<string, unknown>>,
  updatedRows: 1,
}));

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-staff' } } }) },
    from(table: string) {
      let op: 'select' | 'update' = 'select';
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.update = (u: Record<string, unknown>) => {
        op = 'update';
        state.updates.push(u);
        return b;
      };
      b.single = async () =>
        table === 'operator_users'
          ? { data: { operator_id: 'op-1', role: 'staff' } }
          : { data: state.lot };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(
          op === 'update'
            ? { data: Array.from({ length: state.updatedRows }, () => ({ id: 'lot-1' })), error: null }
            : { data: null },
        ).then(res, rej);
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => fakeClient() }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => fakeClient() }));
vi.mock('@/lib/relist', () => ({ relistLotInto: vi.fn() }));

import { editLot } from '../actions';
import { EditLotForm } from '../edit/EditLotForm';
import { lotEditPolicy } from '../edit/lot-edit-policy';

const LOT_ID = '00000000-0000-0000-0000-00000000e417';

function lotRow(over: Partial<LotRow>): LotRow {
  return {
    status: 'scheduled',
    bid_count: 0,
    operator_id: 'op-1',
    msrp_cents: 5000,
    starting_bid_cents: 500,
    flat_price_cents: null,
    dutch_start_cents: null,
    dutch_floor_cents: null,
    dutch_decline_per_minute_cents: null,
    ...over,
  };
}

const edit = {
  lotId: LOT_ID,
  title: 'New title',
  description: 'New description',
  category: 'Tools',
  condition: 'good' as const,
  msrpCents: 5000,
  startingBidCents: 500,
  flatPriceCents: null,
  dutchStartCents: null,
  dutchFloorCents: null,
  dutchDeclinePerMinuteCents: null,
};

beforeEach(() => {
  state.updates = [];
  state.updatedRows = 1;
});

describe('lotEditPolicy', () => {
  it('prices editable only pre-sale with no bids', () => {
    for (const status of ['draft', 'scheduled', 'in_inventory', 'pending_intake']) {
      expect(lotEditPolicy({ status, bidCount: 0 }).pricesLocked).toBe(false);
    }
    expect(lotEditPolicy({ status: 'scheduled', bidCount: 2 })).toEqual({
      pricesLocked: true,
      lockReason: 'the lot has bids',
    });
    expect(lotEditPolicy({ status: 'live', bidCount: 0 }).lockReason).toBe('the lot is live');
    expect(lotEditPolicy({ status: 'won', bidCount: 0 }).lockReason).toBe('the lot has sold');
    expect(lotEditPolicy({ status: 'unsold', bidCount: 0 }).pricesLocked).toBe(true);
  });
});

describe('editLot: case 1, scheduled lot with no bids', () => {
  it('saves title, description, category, condition AND prices', async () => {
    state.lot = lotRow({ status: 'scheduled', bid_count: 0 });
    const r = await editLot({ ...edit, startingBidCents: 900, msrpCents: 7000 });
    expect(r).toMatchObject({ ok: true, pricesLocked: false, dropped: [] });
    expect(state.updates[0]).toMatchObject({
      title: 'New title',
      description: 'New description',
      category: 'Tools',
      condition: 'good',
      starting_bid_cents: 900,
      msrp_cents: 7000,
    });
  });
});

describe('editLot: case 2, live lot or lot with bids', () => {
  it('live lot: descriptive fields save, prices are not written', async () => {
    state.lot = lotRow({ status: 'live', bid_count: 0 });
    const r = await editLot(edit);
    expect(r).toMatchObject({ ok: true, pricesLocked: true, lockReason: 'the lot is live', dropped: [] });
    expect(state.updates[0]).toEqual({
      title: 'New title',
      description: 'New description',
      category: 'Tools',
      condition: 'good',
    });
  });

  it('scheduled lot WITH bids: title still saves, prices locked', async () => {
    state.lot = lotRow({ status: 'scheduled', bid_count: 3 });
    const r = await editLot(edit);
    expect(r).toMatchObject({ ok: true, pricesLocked: true, lockReason: 'the lot has bids' });
    expect(state.updates[0]?.title).toBe('New title');
    expect(state.updates[0]).not.toHaveProperty('starting_bid_cents');
  });
});

describe('editLot: case 3, never OK while dropping', () => {
  it('names each locked price that was sent with a new value', async () => {
    state.lot = lotRow({ status: 'live', bid_count: 4 });
    const r = await editLot({ ...edit, startingBidCents: 1500, msrpCents: 9900 });
    expect(r).toMatchObject({ ok: true, dropped: ['MSRP', 'Starting bid'] });
    expect(state.updates[0]).not.toHaveProperty('msrp_cents');
  });

  it('an update that matched no row is an error, not a save', async () => {
    state.lot = lotRow({ status: 'scheduled', bid_count: 0 });
    state.updatedRows = 0;
    const r = await editLot(edit);
    expect(r.ok).toBe(false);
  });
});

describe('EditLotForm', () => {
  const base = {
    id: LOT_ID,
    title: 'Drill',
    description: '',
    category: '',
    condition: 'good' as const,
    msrp_cents: 5000,
    starting_bid_cents: 500,
    flat_price_cents: null,
    dutch_start_cents: null,
    dutch_floor_cents: null,
    dutch_decline_per_minute_cents: null,
    auction_id: 'a-1',
  };
  const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;
  // renderToString separates adjacent text and expressions with <!-- -->.
  const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, '');

  it('scheduled, no bids: no warning, no locked fields', () => {
    const html = render(<EditLotForm lot={{ ...base, status: 'scheduled', bid_count: 0 }} format="standard" />);
    expect(html).not.toContain('Prices are locked');
    expect(disabledCount(html)).toBe(0);
  });

  it('live with bids: warning names the locked fields; only prices greyed out', () => {
    const html = render(<EditLotForm lot={{ ...base, status: 'live', bid_count: 2 }} format="standard" />);
    expect(html).toContain('Prices are locked because the lot has bids');
    expect(html).toContain('MSRP and Starting bid');
    expect(html).toContain('Title, description, category, condition and photos still save');
    expect(disabledCount(html)).toBe(2);
    expect(html).toContain('opacity:0.45');
  });

  it('dutch lot: the warning lists the dutch price fields too', () => {
    const html = render(<EditLotForm lot={{ ...base, status: 'won', bid_count: 1 }} format="dutch" />);
    expect(html).toContain('MSRP, Starting bid, Dutch start, Dutch floor and Decline rate');
    expect(disabledCount(html)).toBe(5);
  });
});
