import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runClosingSoon } from '../closing-soon';

type Lot = {
  id: string;
  title: string;
  close_at: string;
  current_bid_cents: number | null;
  winner_bidder_id: string | null;
  status: string;
};

type WatchRow = { bidder_id: string; lot_id: string; lots: Lot | null };

// PostgREST returns at most 1,000 rows from a single select, no matter what
// limit/range the caller asks for. The fake enforces the same cap so the test
// catches a query that pulls the whole watchlist and filters in JS.
const HARD_CAP = 1000;

type Call = { filters: string[]; order: string[]; from: number; to: number };

function fakeDb(watchlist: WatchRow[], opts: { fail?: boolean } = {}) {
  const outbox: Record<string, unknown>[] = [];
  const calls: Call[] = [];

  function thenable(
    call: Call,
    filters: ((r: WatchRow) => boolean)[],
    order: string[],
    range: { from: number; to: number } | null,
  ) {
    return {
      then(resolve: (value: { data: unknown; error: { message: string } | null }) => void) {
        if (opts.fail) {
          resolve({ data: null, error: { message: 'boom' } });
          return;
        }
        const filtered = watchlist.filter((r) => filters.every((f) => f(r)));
        const sorted = [...filtered].sort((a, b) => {
          for (const col of order) {
            const av = String((a as Record<string, unknown>)[col] ?? '');
            const bv = String((b as Record<string, unknown>)[col] ?? '');
            if (av !== bv) return av < bv ? -1 : 1;
          }
          return 0;
        });
        const from = range?.from ?? 0;
        const to = range?.to ?? HARD_CAP - 1;
        const size = Math.min(to - from + 1, HARD_CAP);
        resolve({ data: sorted.slice(from, from + Math.max(0, size)), error: null });
      },
    };
  }

  function from(table: string) {
    if (table === 'notifications_outbox') {
      return {
        upsert(
          rows: Record<string, unknown>[],
          upsertOpts?: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          for (const row of rows) {
            const key = upsertOpts?.onConflict ? row[upsertOpts.onConflict] : undefined;
            if (
              upsertOpts?.ignoreDuplicates &&
              key !== undefined &&
              outbox.some((o) => o[upsertOpts.onConflict!] === key)
            ) {
              continue;
            }
            outbox.push(row);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    }

    const filters: ((r: WatchRow) => boolean)[] = [];
    const order: string[] = [];
    let range: { from: number; to: number } | null = null;
    const call: Call = { filters: [], order: [], from: 0, to: 0 };
    calls.push(call);

    const read = (row: WatchRow, col: string): unknown => {
      const [head, tail] = col.split('.');
      if (tail === undefined) return (row as Record<string, unknown>)[col];
      const nested = (row as Record<string, unknown>)[head!] as
        | Record<string, unknown>
        | null
        | undefined;
      return nested ? nested[tail] : undefined;
    };

    const q: Record<string, unknown> = {
      select() {
        return q;
      },
      in(col: string, values: unknown[]) {
        call.filters.push(`${col}=in`);
        filters.push((r) => values.includes(read(r, col)));
        return q;
      },
      gt(col: string, value: string) {
        call.filters.push(`${col}=gt`);
        filters.push((r) => typeof read(r, col) === 'string' && (read(r, col) as string) > value);
        return q;
      },
      lte(col: string, value: string) {
        call.filters.push(`${col}=lte`);
        filters.push((r) => typeof read(r, col) === 'string' && (read(r, col) as string) <= value);
        return q;
      },
      order(col: string) {
        order.push(col);
        call.order.push(col);
        return q;
      },
      range(from: number, to: number) {
        range = { from, to };
        call.from = from;
        call.to = to;
        return q;
      },
      then(resolve: (value: unknown) => void) {
        return thenable(call, filters, order, range).then(resolve);
      },
    };
    return q;
  }

  const sb = { from } as unknown as SupabaseClient;
  return { sb, outbox, calls };
}

const NOW = new Date('2026-11-05T12:00:00Z');
const IN_WINDOW = '2026-11-05T12:05:00Z';
const FAR_FUTURE = '2026-11-06T12:00:00Z';

function lot(over: Partial<Lot> & { id: string }): Lot {
  return {
    title: `lot ${over.id}`,
    close_at: IN_WINDOW,
    current_bid_cents: 100,
    winner_bidder_id: null,
    status: 'live',
    ...over,
  };
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

describe('runClosingSoon', () => {
  it('finds a watched lot that sits past the 1,000-row PostgREST cap', async () => {
    const fillers: WatchRow[] = Array.from({ length: 1000 }, (_, i) => ({
      bidder_id: `bidder-${pad(i)}`,
      lot_id: `filler-${pad(i)}`,
      lots: lot({ id: `filler-${pad(i)}`, close_at: FAR_FUTURE }),
    }));
    const target: WatchRow = {
      bidder_id: 'bidder-zzzz',
      lot_id: 'target-lot',
      lots: lot({ id: 'target-lot' }),
    };
    const { sb, outbox, calls } = fakeDb([...fillers, target]);

    const result = await runClosingSoon({ supabase: sb, now: NOW });

    expect(result).toEqual({ scanned: 1, enqueued: 1 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      kind: 'closing_soon',
      target_user_id: 'bidder-zzzz',
      idempotency_key: 'closing_soon:bidder-zzzz:target-lot:2026-11-05T12:05:00Z',
    });
    // The status/close-time filters must be pushed to SQL, not applied after
    // a capped read.
    expect(calls[0]!.filters).toEqual(
      expect.arrayContaining(['lots.status=in', 'lots.close_at=gt', 'lots.close_at=lte']),
    );
    expect(calls[0]!.order).toEqual(['bidder_id', 'lot_id']);
  });

  it('pages when more than 1,000 watched lots are closing at once', async () => {
    const closing: WatchRow[] = Array.from({ length: 1500 }, (_, i) => ({
      bidder_id: `bidder-${pad(i)}`,
      lot_id: `lot-${pad(i)}`,
      lots: lot({ id: `lot-${pad(i)}` }),
    }));
    const { sb, outbox, calls } = fakeDb(closing);

    const result = await runClosingSoon({ supabase: sb, now: NOW });

    expect(result).toEqual({ scanned: 1500, enqueued: 1500 });
    expect(outbox).toHaveLength(1500);
    expect(outbox.map((r) => r.target_user_id)).toContain('bidder-1499');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.from).toBe(0);
    expect(calls[1]!.from).toBe(1000);
  });

  it('skips the current leader and lots outside the window', async () => {
    const rows: WatchRow[] = [
      {
        bidder_id: 'bidder-aaaa',
        lot_id: 'leader-lot',
        lots: lot({ id: 'leader-lot', winner_bidder_id: 'bidder-aaaa' }),
      },
      {
        bidder_id: 'bidder-bbbb',
        lot_id: 'closed-lot',
        lots: lot({ id: 'closed-lot', close_at: '2026-11-05T11:59:00Z' }),
      },
      {
        bidder_id: 'bidder-cccc',
        lot_id: 'too-far-lot',
        lots: lot({ id: 'far-lot', close_at: '2026-11-05T12:11:00Z' }),
      },
      {
        bidder_id: 'bidder-dddd',
        lot_id: 'not-live-lot',
        lots: lot({ id: 'not-live-lot', status: 'closed' }),
      },
      {
        bidder_id: 'bidder-eeee',
        lot_id: 'target-lot',
        lots: lot({ id: 'target-lot' }),
      },
    ];
    const { sb, outbox } = fakeDb(rows);

    const result = await runClosingSoon({ supabase: sb, now: NOW });

    // The leader still matches the SQL window filters; it is dropped in JS.
    expect(result).toEqual({ scanned: 2, enqueued: 1 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ target_user_id: 'bidder-eeee' });
  });

  it('does not enqueue a duplicate for the same (bidder, lot, close_at)', async () => {
    const rows: WatchRow[] = [
      { bidder_id: 'bidder-aaaa', lot_id: 'lot-a', lots: lot({ id: 'lot-a' }) },
    ];
    const { sb, outbox } = fakeDb(rows);

    await runClosingSoon({ supabase: sb, now: NOW });
    await runClosingSoon({ supabase: sb, now: NOW });

    expect(outbox).toHaveLength(1);
  });

  it('throws instead of silently enqueuing nothing when the read fails', async () => {
    const { sb } = fakeDb([], { fail: true });
    await expect(runClosingSoon({ supabase: sb, now: NOW })).rejects.toThrow(
      'closing-soon: watchlist query failed',
    );
  });
});
