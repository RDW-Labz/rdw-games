import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { duplicateLotArgs } from './duplicate-lot-args';

describe('duplicateLotArgs (0416)', () => {
  it('sends the clocked-in worker with the lot', () => {
    expect(duplicateLotArgs('lot-1', 'worker-tim')).toEqual({
      p_lot_id: 'lot-1',
      p_lotted_by_worker: 'worker-tim',
    });
  });

  it('nobody clocked in → explicit null (server inherits the source lot\'s worker)', () => {
    expect(duplicateLotArgs('lot-1', null)).toEqual({ p_lot_id: 'lot-1', p_lotted_by_worker: null });
    expect(duplicateLotArgs('lot-1', undefined)).toEqual({ p_lot_id: 'lot-1', p_lotted_by_worker: null });
    expect(duplicateLotArgs('lot-1', '  ')).toEqual({ p_lot_id: 'lot-1', p_lotted_by_worker: null });
  });

  it('the Duplicate Lot button passes the worker (Oct 13: duplicates credited to nobody)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../app/(staff)/worklist/[id].tsx'),
      'utf8',
    );
    const calls = src.match(/rpc\(\s*'duplicate_lot'[\s\S]*?\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/duplicateLotArgs\(\s*lot\.id\s*,\s*getActiveLottingWorkerId\(\)\s*\)/);
    }
  });
});
