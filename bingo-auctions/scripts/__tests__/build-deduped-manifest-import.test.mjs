// Unit tests for the pure deduper helpers (key builder, dedup, vendor detect).
//
// Runner: Node's built-in test runner (zero extra config on the Windows box):
//   node --test scripts/__tests__/build-deduped-manifest-import.test.mjs
//
// Scope is intentionally limited to the PURE functions exported by the script;
// file I/O / Supabase / XLSX paths are exercised by running the CLI itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdentityKey,
  dedupeRows,
  detectVendor,
} from '../build-deduped-manifest-import.mjs';

// A representative Wayfair row (matches GateGuard fact #3's synthetic shape).
const wayfairRow = {
  OrderID: 'WF-90021',
  ItemNumber: '445120033',
  ReturnTrackingNumber: '486572077526',
  ProductName: 'Mercury Row Console Table',
  RetailPrice: '$219.99',
};

test('wayfair identity key joins OrderID|ItemNumber|ReturnTrackingNumber, lowercased', () => {
  assert.equal(buildIdentityKey(wayfairRow, 'wayfair'), 'wf-90021|445120033|486572077526');
});

test('wayfair key is whitespace/case tolerant on both header and value', () => {
  const messy = {
    ' Order ID ': '  WF-90021 ',
    item_number: '445120033',
    ReturnTrackingNumber: '486572077526',
  };
  assert.equal(buildIdentityKey(messy, 'wayfair'), 'wf-90021|445120033|486572077526');
});

test('amazon identity key uses ASIN|FNSKU|OrderID', () => {
  const row = { ASIN: 'B00ABCDEF', FNSKU: 'X001ABC', OrderID: '111-222' };
  assert.equal(buildIdentityKey(row, 'amazon'), 'b00abcdef|x001abc|111-222');
});

test('generic key collects every populated identifier-ish field, sorted', () => {
  const row = { SKU: 'SK1', UPC: '012345678905', Title: 'ignored', PO_Number: 'PO9' };
  const key = buildIdentityKey(row, 'generic');
  assert.ok(key.includes('sku=sk1'));
  assert.ok(key.includes('upc=012345678905'));
  assert.ok(key.includes('ponumber=po9'));
  assert.ok(!key.includes('title'), 'non-identifier fields must not contribute');
});

test('empty/blank identifiers yield an empty key (row is kept, never collapsed)', () => {
  assert.equal(buildIdentityKey({ ProductName: 'No IDs here' }, 'wayfair'), '');
  assert.equal(buildIdentityKey({ Foo: '', Bar: '   ' }, 'generic'), '');
});

test('dedupeRows keeps the FIRST occurrence and counts drops', () => {
  const dup = { ...wayfairRow, RetailPrice: '$999.00' }; // same identity, diff price
  const distinct = { ...wayfairRow, ReturnTrackingNumber: '486572077559' };
  const { rows, dropped } = dedupeRows([wayfairRow, dup, distinct], 'wayfair');
  assert.equal(dropped, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].RetailPrice, '$219.99', 'first occurrence is the one kept');
});

test('dedupeRows never collapses keyless rows together', () => {
  const a = { ProductName: 'thing a' };
  const b = { ProductName: 'thing b' };
  const { rows, dropped } = dedupeRows([a, b], 'wayfair');
  assert.equal(dropped, 0);
  assert.equal(rows.length, 2);
});

test('detectVendor recognizes wayfair, amazon, and falls back to generic', () => {
  assert.equal(
    detectVendor(new Set(['orderid', 'itemnumber', 'returntrackingnumber', 'productname'])),
    'wayfair',
  );
  assert.equal(detectVendor(new Set(['asin', 'fnsku', 'lpn'])), 'amazon');
  assert.equal(detectVendor(new Set(['sku', 'description'])), 'generic');
});
