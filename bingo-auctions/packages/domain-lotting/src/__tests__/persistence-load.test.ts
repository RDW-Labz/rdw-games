// Mig 0428: lots created during a shift carry the load picked for it.
// The create call must be byte-for-byte unchanged when no load is picked, add
// p_load_id when one is, and fall back to the old call when the server does
// not have the new function yet — lotting must never break on deploy order.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDraftLotFromCandidate,
  setActiveLottingLoadId,
  isMissingLoadOverload,
} from '../persistence';

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function fakeSupabase(results: RpcResult[]) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    calls,
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.update = () => b;
      b.in = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
      return b;
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'create_draft_lot') calls.push(args);
      const r = name === 'create_draft_lot' ? results.shift() ?? { data: null, error: { message: 'no result' } } : { data: null, error: null };
      return { single: async () => r, then: (res: (v: unknown) => unknown) => Promise.resolve(r).then(res) };
    },
  };
  return client;
}

const OK: RpcResult = { data: { out_id: 'lot-1', out_lot_code: 'BIN-000001' }, error: null };
const input = {
  operatorId: '00000000-0000-0000-0000-000000000001',
  candidate: { title: 'Chair', condition: 'good', msrp: 100, startingBid: 1 } as never,
};

beforeEach(() => setActiveLottingLoadId(null));

describe('create_draft_lot and the shift load (mig 0428)', () => {
  it('no load picked: the call has no p_load_id (unchanged /23 call)', async () => {
    const sb = fakeSupabase([OK]);
    await createDraftLotFromCandidate(sb as never, input);
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0]).not.toHaveProperty('p_load_id');
    expect(sb.calls[0]).toHaveProperty('p_lotted_by_worker');
  });

  it('load picked: the call carries p_load_id', async () => {
    setActiveLottingLoadId('load-brn-12');
    const sb = fakeSupabase([OK]);
    await createDraftLotFromCandidate(sb as never, input);
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0]).toMatchObject({ p_load_id: 'load-brn-12' });
  });

  it('server without 0428 (PGRST202): retries once without p_load_id and succeeds', async () => {
    setActiveLottingLoadId('load-brn-12');
    const sb = fakeSupabase([
      { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.create_draft_lot(... p_load_id ...)' } },
      OK,
    ]);
    const r = await createDraftLotFromCandidate(sb as never, input);
    expect(sb.calls).toHaveLength(2);
    expect(sb.calls[1]).not.toHaveProperty('p_load_id');
    expect((r as { ok: boolean }).ok).toBe(true);
  });

  it('any other error is not retried (no duplicate lot)', async () => {
    setActiveLottingLoadId('load-brn-12');
    const sb = fakeSupabase([{ data: null, error: { code: '23514', message: 'title_length' } }, OK]);
    const r = await createDraftLotFromCandidate(sb as never, input);
    expect(sb.calls).toHaveLength(1);
    expect((r as { ok: boolean }).ok).toBe(false);
  });

  it('blank ids count as no load', async () => {
    setActiveLottingLoadId('   ');
    const sb = fakeSupabase([OK]);
    await createDraftLotFromCandidate(sb as never, input);
    expect(sb.calls[0]).not.toHaveProperty('p_load_id');
  });

  it('isMissingLoadOverload only matches function-not-found', () => {
    expect(isMissingLoadOverload({ code: 'PGRST202' })).toBe(true);
    expect(isMissingLoadOverload({ message: 'function ... p_load_id does not exist' })).toBe(true);
    expect(isMissingLoadOverload({ code: '23514', message: 'title_length' })).toBe(false);
    expect(isMissingLoadOverload(null)).toBe(false);
  });
});
