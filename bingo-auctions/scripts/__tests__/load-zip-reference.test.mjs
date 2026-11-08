// scripts/load-zip-reference.mjs: parser, zip reader, batching, args.
// Fixture lines in GeoNames' US.txt format (public place data, no people).
// Never downloads: the network path is not exercised here.
// Run: node --test scripts/__tests__/load-zip-reference.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  ATTRIBUTION,
  BATCH_SIZE,
  GEONAMES_US_URL,
  extractZipEntry,
  parseArgs,
  parseGeoNamesUS,
  toBatches,
} from '../load-zip-reference.mjs';

const T = '\t';
const line = (...cols) => cols.join(T);
const FIXTURE = [
  line('US', '72764', 'Springdale', 'Arkansas', 'AR', 'Washington', '143', '', '', '36.1716', '-94.0428', '4'),
  line('US', '72765', 'Springdale', 'Arkansas', 'AR', 'Washington', '143', '', '', '36.1725', '-94.1535', '4'), // PO-box ZIP
  line('US', '72601', 'Harrison', 'Arkansas', 'AR', 'Boone', '009', '', '', '36.24171', '-93.10624', '4'),
  line('US', '09001', 'APO AA', '', '', '', '', '', '', '38.1105', '15.6613', ''), // military: state from the name
  line('US', '96860', 'FPO AA', '', '', '', '', '', '', '21.3448', '-157.9774', '4'), // dup, military first
  line('US', '96860', 'Jbphh', 'Hawaii', 'HI', 'Honolulu', '003', '', '', '21.316', '-157.8677', '1'), // dup with a real state wins
  line('US', '10001', 'New York', 'New York', 'NY', 'New York', '061', '', '', '40.7484', '-73.9967', '4'),
  line('US', '10001', 'Somewhere Else', 'New York', 'NY', 'New York', '061', '', '', '', '', ''), // dup, first kept
  line('US', '96365', 'APO STA', '', '', '', '', '', '', '26.3652', '127.7586', ''), // no state → skipped
  line('US', '1234', 'Short', 'X', 'XX', '', '', '', '', '', '', ''), // not 5 digits → skipped
  line('CA', 'A1A1A', 'Elsewhere', 'Ontario', 'ON', '', '', '', '', '', '', ''), // not US → skipped
  line('US', '72712', '', 'Arkansas', 'AR', 'Benton', '', '', '', '', '', ''), // no place → skipped
  line('US', '72756', 'Rogers', 'Arkansas', 'ar', 'Benton', '007', '', '', 'x', '999', '4'), // lower-case code; bad coords → null
  '',
].join('\r\n');

test('parse: one row per ZIP, states, military codes, duplicates, skips', () => {
  const { rows, skipped, duplicates } = parseGeoNamesUS(FIXTURE);
  assert.equal(skipped, 4);
  assert.equal(duplicates, 2);
  assert.deepEqual(rows.map((r) => [r.postal_code, r.city, r.state]), [
    ['09001', 'APO AA', 'AA'],
    ['10001', 'New York', 'NY'],
    ['72601', 'Harrison', 'AR'],
    ['72756', 'Rogers', 'AR'],
    ['72764', 'Springdale', 'AR'],
    ['72765', 'Springdale', 'AR'],
    ['96860', 'Jbphh', 'HI'],
  ]);
  const h = rows.find((r) => r.postal_code === '72601');
  assert.deepEqual(h, {
    postal_code: '72601', city: 'Harrison', state: 'AR', county: 'Boone',
    lat: 36.2417, lon: -93.1062, source: 'geonames',
  });
  const r = rows.find((x) => x.postal_code === '72756');
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
  assert.equal(rows.find((x) => x.postal_code === '09001').county, null);
  // every row satisfies the 0438 table checks
  for (const x of rows) {
    assert.match(x.postal_code, /^[0-9]{5}$/);
    assert.match(x.state, /^[A-Z]{2}$/);
    assert.ok(x.city.trim().length >= 1 && x.city.length <= 100);
  }
});

// Minimal zip writer for the test (local header + central directory + EOCD).
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBuf = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('zip reader: deflated and stored entries, picks US.txt next to readme.txt', { skip: typeof crc32 !== 'function' && 'zlib.crc32 needs Node 20.15+' }, () => {
  const txt = Buffer.from(FIXTURE);
  for (const method of [8, 0]) {
    const zip = makeZip([
      { name: 'readme.txt', data: Buffer.from('This work is licensed under CC BY 4.0'), method },
      { name: 'US.txt', data: txt, method },
    ]);
    assert.equal(extractZipEntry(zip, 'US.txt').toString('utf8'), FIXTURE);
  }
  assert.throws(() => extractZipEntry(makeZip([{ name: 'a.txt', data: txt, method: 0 }]), 'US.txt'), /not found/);
  assert.throws(() => extractZipEntry(Buffer.from('not a zip at all, just some bytes'), 'US.txt'), /not a zip/);
});

test('batches of 2,000 cover every row once', () => {
  const rows = Array.from({ length: 4501 }, (_, i) => ({ i }));
  const b = toBatches(rows);
  assert.equal(BATCH_SIZE, 2000);
  assert.deepEqual(b.map((x) => x.length), [2000, 2000, 501]);
  assert.equal(b.flat().length, 4501);
  assert.deepEqual(toBatches([]), []);
});

test('args: dry run by default, --live opt-in, --file path, unknown refused', () => {
  assert.deepEqual(parseArgs([]), { live: false, file: null });
  assert.deepEqual(parseArgs(['--file', './US.zip']), { live: false, file: './US.zip' });
  assert.deepEqual(parseArgs(['--live']), { live: true, file: null });
  assert.throws(() => parseArgs(['--file']), /needs a path/);
  assert.throws(() => parseArgs(['--force']), /unknown option/);
});

test('documents the source and the licence credit', () => {
  assert.equal(GEONAMES_US_URL, 'https://download.geonames.org/export/zip/US.zip');
  assert.match(ATTRIBUTION, /GeoNames/);
  assert.match(ATTRIBUTION, /CC BY 4\.0/);
});
