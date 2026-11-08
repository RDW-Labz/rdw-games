// Mig 0428: every staff lot-create path carries the shift's load.
// create_draft_lot callers get it through domain-lotting (setActiveLottingLoadId);
// the Web screen inserts into lots directly, so it must set load_id itself.
// A future edit that drops it would silently stop linking web-lotted items.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const WEB = join(__dirname, '..', 'app', '(staff)', 'lotting', 'web.tsx');

describe('Web lotting carries the shift load', () => {
  it('the direct lots insert sets load_id from the active lotting load', () => {
    const src = readFileSync(WEB, 'utf8');
    const insert = src.slice(src.indexOf(".from('lots')\n        .insert({"));
    expect(insert.length).toBeGreaterThan(0);
    const block = insert.slice(0, insert.indexOf('})'));
    expect(block).toMatch(/load_id:\s*getActiveLottingLoadId\(\)/);
  });
});
