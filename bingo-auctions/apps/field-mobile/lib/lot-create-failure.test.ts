// Tests for the failed-save copy and the server-side failure record.
// Fake data only: synthetic Postgres messages, no titles, prices or people.

import { describe, it, expect } from 'vitest';
import {
  classifyLotCreateFailure,
  lotCreateFailureReport,
  lotCreateUserMessage,
  serverText,
  type LotCreateFailure,
} from './lot-create-failure';

const insert = (reason: string): LotCreateFailure => ({ code: 'insert_failed', reason });

describe('classifyLotCreateFailure', () => {
  it('names a Supabase statement timeout "server slow"', () => {
    expect(classifyLotCreateFailure(insert('create_draft_lot: canceling statement due to statement timeout'))).toBe('server_slow');
  });
  it('names a dropped network request "server slow"', () => {
    expect(classifyLotCreateFailure(insert('create_draft_lot: TypeError: Network request failed'))).toBe('server_slow');
    expect(classifyLotCreateFailure(insert('create_draft_lot: fetch failed'))).toBe('server_slow');
    expect(classifyLotCreateFailure(insert('create_draft_lot: 502 Bad Gateway'))).toBe('server_slow');
  });
  it('names a sticker already on another lot "duplicate sticker"', () => {
    expect(
      classifyLotCreateFailure(
        insert('create_draft_lot: duplicate key value violates unique constraint "lots_sticker_code_per_operator"'),
      ),
    ).toBe('duplicate_sticker');
  });
  it('names a missing sticker "no sticker"', () => {
    expect(
      classifyLotCreateFailure(insert('create_draft_lot: null value in column "sticker_code" violates not-null constraint')),
    ).toBe('no_sticker');
    expect(classifyLotCreateFailure(insert('create_draft_lot: sticker required in prestickered mode'))).toBe('no_sticker');
  });
  it('keeps the duplicate-code and reserve-failed causes', () => {
    expect(classifyLotCreateFailure({ code: 'duplicate_external_code', reason: 'x' })).toBe('duplicate_code');
    expect(classifyLotCreateFailure({ code: 'rpc_failed', reason: 'create_draft_lot: operator not found' })).toBe('no_lot_code');
  });
  it('names an expired session', () => {
    expect(classifyLotCreateFailure({ code: 'rpc_failed', reason: 'create_draft_lot: not_authenticated (28000)' })).toBe('not_signed_in');
    expect(classifyLotCreateFailure(insert('create_draft_lot: new row violates row-level security policy'))).toBe('not_signed_in');
  });
  it('names a CHECK violation "out of range"', () => {
    expect(
      classifyLotCreateFailure(insert('create_draft_lot: Title is too long or empty. (new row violates check constraint "lots_title_length")')),
    ).toBe('out_of_range');
  });
  it('falls back to unknown for anything else, including no reason at all', () => {
    expect(classifyLotCreateFailure(insert('create_draft_lot: something new'))).toBe('unknown');
    expect(classifyLotCreateFailure({ code: 'insert_failed' })).toBe('unknown');
  });
});

describe('lotCreateUserMessage', () => {
  it('leads with the plain cause and ends with what the server said', () => {
    const { title, message } = lotCreateUserMessage(insert('create_draft_lot: canceling statement due to statement timeout'));
    expect(title).toBe('Could not create lot');
    expect(message.startsWith('Server slow, try again.')).toBe(true);
    expect(message).toContain('Server said: canceling statement due to statement timeout');
    expect(message).not.toContain('create_draft_lot:');
  });
  it('says "No sticker scanned" and "Duplicate sticker" in those words', () => {
    expect(lotCreateUserMessage(insert('null value in column "sticker_code"')).message).toMatch(/^No sticker scanned\./);
    expect(lotCreateUserMessage(insert('duplicate key value violates unique constraint "lots_sticker_code_per_operator"')).message).toMatch(/^Duplicate sticker\./);
  });
  it('still shows the old generic sentence plus the server text when the cause is unknown', () => {
    const { message } = lotCreateUserMessage(insert('create_draft_lot: weird new failure'));
    expect(message).toMatch(/^Couldn't save the lot\./);
    expect(message).toContain('Server said: weird new failure');
  });
  it('omits the server line when there is nothing to show', () => {
    expect(lotCreateUserMessage({ code: 'insert_failed', reason: '' }).message).not.toContain('Server said');
  });
  it('caps a very long server message', () => {
    const long = 'x'.repeat(1000);
    const { message } = lotCreateUserMessage(insert(long));
    expect(message.length).toBeLessThanOrEqual(340);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('serverText', () => {
  it('strips the module prefix and collapses whitespace', () => {
    expect(serverText('create_draft_lot:   a\n  b   c ')).toBe('a b c');
    expect(serverText(null)).toBe('');
  });
});

describe('lotCreateFailureReport', () => {
  it('builds a non-fatal report with the code, cause, mode and server text', () => {
    const body = lotCreateFailureReport(insert('create_draft_lot: canceling statement due to statement timeout'), {
      screen: '/lotting/quick',
      lottingMode: 'prestickered',
      manifestMatch: true,
      appVersion: '1.0.1',
      otaUpdate: 'abc',
    });
    expect(body.is_fatal).toBe(false);
    expect(body.screen).toBe('/lotting/quick');
    expect(body.app_version).toBe('1.0.1');
    expect(body.ota_update).toBe('abc');
    expect(body.message).toBe(
      'lot create failed [insert_failed/server_slow] mode=prestickered manifest=yes: canceling statement due to statement timeout',
    );
  });
  it('never exceeds the 500-character limit the crash route enforces', () => {
    const body = lotCreateFailureReport(insert('y'.repeat(2000)), { screen: '/lotting/photo' });
    expect(body.message.length).toBeLessThanOrEqual(500);
    expect(body.message.startsWith('lot create failed [insert_failed/unknown] mode=- manifest=no: ')).toBe(true);
  });
  it('leaves optional fields out when absent, so the route schema accepts it', () => {
    const body = lotCreateFailureReport({ code: 'rpc_failed' }, { screen: '/lotting/manual' });
    expect('app_version' in body).toBe(false);
    expect('ota_update' in body).toBe(false);
    expect(body.message).toBe('lot create failed [rpc_failed/no_lot_code] mode=- manifest=no: ');
  });
});
