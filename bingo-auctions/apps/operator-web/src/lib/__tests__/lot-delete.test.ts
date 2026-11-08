import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOOTPRINT_ERROR_PREFIX,
  FOOTPRINT_REASONS,
  footprintReasonsFromLot,
  footprintRefusalMessage,
  isFootprintRefusal,
  lotDeleteErrorMessage,
} from '../lot-delete';

// The 0400 trigger's error, as PostgREST hands it back to supabase-js.
const triggerError = (details: string) => ({
  code: 'P0001',
  message: `${FOOTPRINT_ERROR_PREFIX}: BIN-028904 cannot be deleted (${details.split(',').join(', ')})`,
  details,
  hint: 'Use Remove from inventory on the lot page instead of deleting it.',
});

describe('footprintReasonsFromLot', () => {
  it('reads sticker, shelf and intake off the row', () => {
    expect(
      footprintReasonsFromLot({ sticker_code: 'BRN:4982227', intake_bin_id: 'b1', intake_at: '2026-10-01T12:00:00Z' }),
    ).toEqual(['sticker_code', 'intake_bin_id', 'intake_at']);
  });
  it('a bare draft has none', () => {
    expect(footprintReasonsFromLot({ sticker_code: null, intake_bin_id: null, intake_at: null })).toEqual([]);
    expect(footprintReasonsFromLot({})).toEqual([]);
  });
});

describe('footprintRefusalMessage', () => {
  it('names each kind of evidence once, in staff words, and points to Remove from inventory', () => {
    const msg = footprintRefusalMessage([...FOOTPRINT_REASONS]);
    expect(msg).toBe(
      "This lot has a sticker, a shelf and location history, so it's a real item and can't be deleted. " +
        'Use Remove from inventory on the lot page to dispose of it instead.',
    );
  });
  it('one reason', () => {
    expect(footprintRefusalMessage(['lot_location_events'])).toMatch(/^This lot has location history, so/);
    expect(footprintRefusalMessage(['lot_sticker_pool'])).toMatch(/^This lot has a sticker, so/);
  });
  it('two reasons', () => {
    expect(footprintRefusalMessage(['bin_assignments', 'sticker_code'])).toMatch(/^This lot has a sticker and a shelf, so/);
  });
  it('unknown reason codes still refuse with generic wording', () => {
    expect(footprintRefusalMessage(['something_new'])).toMatch(/^This lot has a record in the warehouse, so/);
  });
});

describe('lotDeleteErrorMessage', () => {
  it('maps the trigger refusal to staff copy, never the raw error', () => {
    const msg = lotDeleteErrorMessage(triggerError('sticker_code,intake_bin_id,intake_at,lot_location_events'));
    expect(msg).toContain('a sticker, a shelf and location history');
    expect(msg).toContain('Remove from inventory');
    expect(msg).not.toContain(FOOTPRINT_ERROR_PREFIX);
    expect(msg).not.toContain('intake_bin_id');
  });
  it('a refusal with empty details still maps', () => {
    const msg = lotDeleteErrorMessage({ message: `${FOOTPRINT_ERROR_PREFIX}: x cannot be deleted ()`, details: null });
    expect(msg).toContain('Remove from inventory');
  });
  it('other errors pass through unchanged', () => {
    expect(lotDeleteErrorMessage({ message: 'update or delete on table "lots" violates foreign key constraint' })).toBe(
      'update or delete on table "lots" violates foreign key constraint',
    );
    expect(isFootprintRefusal({ message: 'permission denied for table lots' })).toBe(false);
  });
  it('no error object', () => {
    expect(lotDeleteErrorMessage(null)).toBe('Could not delete this lot.');
  });
});

// Once the 0400 migration is added to packages/db/migrations, hold this file
// to its reason codes and error prefix. Until then there is nothing to read.
const migDir = path.resolve(__dirname, '../../../../../packages/db/migrations');
const migFile = fs
  .readdirSync(migDir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.includes('ROLLBACK'))
  .find((f) => fs.readFileSync(path.join(migDir, f), 'utf8').includes(`'${FOOTPRINT_ERROR_PREFIX}:`));

describe.skipIf(!migFile)('lot-delete matches the trigger migration', () => {
  it('every reason code and the prefix appear in the trigger body', () => {
    const sql = fs.readFileSync(path.join(migDir, migFile as string), 'utf8');
    for (const r of FOOTPRINT_REASONS) expect(sql).toContain(`'${r}'`);
    expect(sql).toContain(`'${FOOTPRINT_ERROR_PREFIX}: `);
  });
});
