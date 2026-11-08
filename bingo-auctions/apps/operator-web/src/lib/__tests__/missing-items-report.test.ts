import { describe, it, expect } from 'vitest';
import {
  MISSING_CSV_HEADER,
  missingActionError,
  missingCsvLine,
  reasonText,
  type MissingRow,
} from '../missing-items-report';

const row: MissingRow = {
  lot_id: 'l1',
  lot_code: 'BIN-029252',
  display_code: 'PNK4821346',
  title: 'Chair, "grey", 2-pack',
  photo_url: 'https://x.test/a.jpg',
  lot_status: 'unsold',
  warehouse_id: 'wh1',
  warehouse_name: 'Bentonville',
  location_code: 'A-01-02',
  location_at: '2026-09-28T15:44:42Z',
  missing_at: '2026-10-09T19:51:54Z',
  source: 'pickup',
  reason: null,
  marked_by_name: 'Jourdan',
  state: 'open',
  last_check_at: null,
  last_check_outcome: null,
  last_check_note: null,
  last_check_by_name: null,
  check_count: 0,
};

describe('missing items CSV', () => {
  it('has one cell per header column and quotes commas and quotes', () => {
    const line = missingCsvLine(row);
    expect(line).toContain('"Chair, ""grey"", 2-pack"');
    // Count cells by parsing: strip the one quoted cell first.
    const cells = line.replace(/"(?:[^"]|"")*"/g, 'Q').split(',');
    expect(cells).toHaveLength(MISSING_CSV_HEADER.length);
    expect(cells[8]).toBe('Not found at pickup');
    expect(cells[9]).toBe('Still missing');
    // mig 0452: warehouse is the last column, so adding it didn't reindex
    // anything above.
    expect(cells[cells.length - 1]).toBe('Bentonville');
  });

  it('leaves the warehouse cell blank when the row has none', () => {
    const line = missingCsvLine({ ...row, warehouse_id: null, warehouse_name: null });
    const cells = line.split(',');
    expect(cells[cells.length - 1]).toBe('');
  });

  it('labels the last check outcome', () => {
    const line = missingCsvLine({
      ...row,
      title: 'x',
      state: 'unsellable',
      last_check_outcome: 'unsellable',
      last_check_by_name: 'Jared',
      check_count: 1,
    });
    expect(line.split(',').slice(9, 13)).toEqual(['Unsellable — awaiting disposal', '', 'Unsellable', 'Jared']);
  });
});

describe('reasonText', () => {
  it('uses the recorded note, else a default per source', () => {
    expect(reasonText({ reason: 'Box empty', source: 'pickup' })).toBe('Box empty');
    expect(reasonText({ reason: null, source: 'removal' })).toBe('Removed from inventory as missing');
  });
});

describe('missingActionError', () => {
  it('maps RPC reasons to staff text', () => {
    expect(missingActionError('admin_or_manager_required')).toBe('Admins or managers only.');
    expect(missingActionError('already_removed_as_missing')).toBe('Already removed from inventory (missing).');
    expect(missingActionError('weird')).toBe('Could not save: weird');
  });

  it('mig 0445: a written-off relist names the relist lot', () => {
    expect(missingActionError('relist_removed_as_other', 'BIN-014913')).toBe(
      'This item was relisted as BIN-014913, and that lot was removed from inventory (other). Re-lot the box instead.',
    );
    expect(missingActionError('relist_removed_as_bin_store')).toBe(
      'This item was relisted, and that lot was removed from inventory (bin store). Re-lot the box instead.',
    );
  });

  it('pending_move gets plain words instead of the raw code', () => {
    expect(missingActionError('pending_move')).toMatch(/different shelf.*Put-away/);
  });
});
