// Unit tests for the empty-import load archive (#533).
//
// Runner: node --test scripts/__tests__/import-d2l-manifest-empty-load.test.mjs
//
// Covers the pure patch builder and its non-fatal wrapper; `rest` is a stub,
// so nothing here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyImportLoadPatch,
  archiveEmptyImportLoad,
} from '../import-d2l-manifest.mjs';

const IMPORT_ID = '00000000-0000-4000-8000-000000000533';
const NOW = '2026-10-20T08:00:00.000Z';

test('0 inserted: archive patch targets exactly that import\'s open auto-import load', async () => {
  assert.deepEqual(emptyImportLoadPatch(0, IMPORT_ID, NOW), {
    path: `loads?import_id=eq.${IMPORT_ID}&type=eq.auto-import&archived_at=is.null`,
    body: { archived_at: NOW },
  });

  const calls = [];
  const result = await archiveEmptyImportLoad(0, IMPORT_ID, async (path, init) => {
    calls.push({ path, init });
    return [];
  }, NOW);
  assert.equal(result, 'archived');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `loads?import_id=eq.${IMPORT_ID}&type=eq.auto-import&archived_at=is.null`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { archived_at: NOW });
});

test('1+ inserted: no patch, rest never called', async () => {
  assert.equal(emptyImportLoadPatch(1, IMPORT_ID, NOW), null);
  assert.equal(emptyImportLoadPatch(812, IMPORT_ID, NOW), null);

  let called = false;
  const result = await archiveEmptyImportLoad(5, IMPORT_ID, async () => {
    called = true;
  }, NOW);
  assert.equal(result, 'skipped');
  assert.equal(called, false);
});

test('failed archive only warns, never throws', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const result = await archiveEmptyImportLoad(0, IMPORT_ID, async () => {
    throw new Error('loads → 500: boom');
  }, NOW);
  assert.equal(result, 'failed');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /load archive failed.*boom/);
});
