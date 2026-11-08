import { describe, expect, it } from 'vitest';
import { resolveTypedBin } from './typed-bin-lookup';

const H = { code: '3-09-01', warehouse_id: 'h', qr_token: 'tok-h' };
const D = { code: '3-09-01', warehouse_id: 'd', qr_token: 'tok-d' };
const names = new Map([['h', 'Harrison'], ['d', 'Dodge City']]);

describe('resolveTypedBin', () => {
  it('one row scoped to the warehouse → that bin (the 3-09-01 Harrison case)', () => {
    expect(resolveTypedBin([H], '3-09-01', 'Harrison')).toEqual({ kind: 'one', bin: H });
  });
  it('none at this location → names the location', () => {
    const r = resolveTypedBin([], '3-09-01', 'Harrison');
    expect(r.kind).toBe('none');
    expect(r.kind === 'none' && r.detail).toContain('at Harrison');
  });
  it('none with no location known → operator-wide wording', () => {
    const r = resolveTypedBin([], 'Z-9', null);
    expect(r.kind === 'none' && r.detail).toContain('for your operator');
  });
  it('several (no location to scope by) → says where, asks for the QR', () => {
    const r = resolveTypedBin([H, D], '3-09-01', null, names);
    expect(r).toEqual({
      kind: 'many',
      title: 'Several bins have that code',
      detail: '"3-09-01" exists at Harrison, Dodge City. Scan the bin\'s QR code, or switch to the right location and try again.',
    });
  });
});
