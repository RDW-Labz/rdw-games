// Opt-in integration test: RUNNER_PG_TEST=1 PGHOST=127.0.0.1 PGPORT=5432
// PGUSER=postgres node --test scripts/__tests__/migration-runner-compat.test.cjs
// Requires pg@8 (NODE_PATH may point at a temporary install). No hosted calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const migration = '0359_pull_url_titled_lots_from_auctions.sql';
const enabled = process.env.RUNNER_PG_TEST === '1';
const batch = 'bf0107e4-32d3-407e-b5e5-0cf7320b2751';
const target = '00000000-0000-4000-8000-000000000001';
const control = '00000000-0000-4000-8000-000000000002';

async function fixture(t) {
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST),
    'Explicit loopback PGHOST required; these tests never target hosted databases');
  assert.match(process.env.PGPORT || '', /^\d+$/, 'Explicit PGPORT required');
  assert.ok(process.env.PGUSER, 'Explicit PGUSER required');
  const pgPath = require.resolve('pg');
  const { Client } = require(pgPath);
  const config = {
    host: process.env.PGHOST, port: Number(process.env.PGPORT),
    user: process.env.PGUSER, password: process.env.PGPASSWORD || '',
    ssl: false, connectionTimeoutMillis: 5000,
  };
  const db = `runner_compat_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ ...config, database: 'postgres' });
  await admin.connect();
  let client;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-compat-'));
  t.after(async () => {
    try {
      if (client) await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    } finally {
      await admin.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  await admin.query(`CREATE DATABASE "${db}"`);
  client = new Client({ ...config, database: db });
  await client.connect();
  await client.query(`
    CREATE TABLE lots (id uuid PRIMARY KEY, lot_import_batch_id uuid,
      status text, auction_id uuid, lot_number int, close_at timestamptz,
      updated_at timestamptz);
    CREATE TABLE bids (lot_id uuid);
    CREATE TABLE invoice_lots (lot_id uuid);
    CREATE TABLE timeout_observations (value text);
    CREATE TABLE _schema_migrations (filename text PRIMARY KEY,
      applied_at timestamptz, applied_by text, duration_ms integer, checksum text);
    INSERT INTO lots VALUES
      ('${target}', '${batch}', 'scheduled', '${control}', 10, '2026-01-01', '2026-01-01'),
      ('${control}', NULL, 'scheduled', '${control}', 11, '2026-01-01', '2026-01-01');
  `);
  const scripts = path.join(dir, 'scripts');
  const migrations = path.join(dir, 'packages/db/migrations');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(migrations, { recursive: true });
  for (const name of ['apply-migrations.js', 'push-hosted-migrations.js']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name));
  }
  // Include the real helper when present: a regression must fail for the
  // mandatory review/transaction policy, not a missing require() dependency.
  const helper = path.join(root, 'scripts/lib/migration-review.cjs');
  if (fs.existsSync(helper)) {
    fs.mkdirSync(path.join(scripts, 'lib'));
    fs.copyFileSync(helper, path.join(scripts, 'lib/migration-review.cjs'));
  }
  const sql = fs.readFileSync(path.join(root, 'packages/db/migrations', migration));
  fs.writeFileSync(path.join(migrations, migration), sql); // Exact historical SQL.
  assert.match(sql.toString(), /\bBEGIN;/);
  assert.match(sql.toString(), /\bCOMMIT;/);
  fs.writeFileSync(path.join(migrations, '0360_timeout_probe.sql'),
    "INSERT INTO timeout_observations VALUES (current_setting('statement_timeout'));\n");
  assert.equal(fs.existsSync(path.join(dir, 'packages/db/migration-reviews')), false);

  // Real pg driver and persistent connection for the direct path. Only TLS is
  // disabled for this loopback fixture. The fetch adapter executes each API
  // request on a fresh real connection; it never sends HTTP or reads secrets.
  const preload = path.join(dir, 'local-transport.cjs');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const realPg = require(${JSON.stringify(pgPath)});
    const config = ${JSON.stringify({ ...config, database: db, options: '-c statement_timeout=7000' })};
    class LocalClient extends realPg.Client {
      constructor(input) {
        if (input.connectionString !== process.env.POSTGRES_URL) throw Error('Unexpected target');
        super(config);
      }
    }
    const originalLoad = Module._load;
    Module._load = function(name, ...args) {
      return name === 'pg' ? { ...realPg, Client: LocalClient } : originalLoad.call(this, name, ...args);
    };
    global.fetch = async (url, options) => {
      if (url !== 'https://api.supabase.com/v1/projects/runner-compat-fixture/database/query')
        throw Error('Unexpected network request blocked');
      const connection = new realPg.Client(config);
      try {
        await connection.connect();
        const result = await connection.query(JSON.parse(options.body).query);
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        return { ok: true, text: async () => JSON.stringify(last.rows || []) };
      } catch (error) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ message: error.message }) };
      } finally { await connection.end(); }
    };
  `, { mode: 0o600 });
  function run(backend, args, helper = 'apply-migrations.js', extra = {}) {
    const result = spawnSync(process.execPath, ['--require', preload, path.join(scripts, helper), ...args], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: {
        PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '',
        SUPABASE_ACCESS_TOKEN: backend === 'mgmt' ? 'synthetic-token' : '',
        SUPABASE_PROJECT_REF: 'runner-compat-fixture',
        POSTGRES_URL: `postgresql://localhost/${db}`, APPLIED_BY: 'runner-compat-fixture', ...extra,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${backend} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  async function snapshot() {
    return (await client.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lots l) AS lots,
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY filename) FROM _schema_migrations m) AS tracking,
      (SELECT jsonb_agg(to_jsonb(o)) FROM timeout_observations o) AS observations`)).rows;
  }
  async function assertDetached() {
    const row = (await client.query('SELECT * FROM lots WHERE id=$1', [target])).rows[0];
    assert.equal(row.status, 'in_inventory');
    assert.equal(row.auction_id, null);
    assert.equal(row.lot_number, null);
    assert.equal(row.close_at, null);
    assert.equal((await client.query('SELECT status FROM lots WHERE id=$1', [control])).rows[0].status, 'scheduled');
  }
  return { client, migrations, run, snapshot, assertDetached, sql };
}

for (const backend of ['mgmt', 'pg']) {
  test(`${backend}: historical BEGIN/COMMIT rerun without reviews; status/dry-run read-only`, { skip: !enabled }, async t => {
    const f = await fixture(t);
    await f.client.query('INSERT INTO _schema_migrations(filename, checksum) VALUES ($1,$2)', [migration, 'previous']);
    const before = await f.snapshot();
    f.run(backend, ['--status']);
    f.run(backend, ['--rerun', migration, '--dry-run']);
    assert.deepEqual(await f.snapshot(), before);
    f.run(backend, ['--rerun', migration]);
    await f.assertDetached();
    assert.equal((await f.client.query('SELECT checksum FROM _schema_migrations WHERE filename=$1', [migration])).rows[0].checksum,
      crypto.createHash('sha256').update(f.sql).digest('hex').slice(0, 16));
    f.run(backend, []); // Default applies the pending timeout probe, preserving session policy.
    assert.deepEqual((await f.client.query('SELECT value FROM timeout_observations')).rows, [{ value: '7s' }]);
  });
}

test('push-hosted START_AT skips earlier SQL and applies historical transaction plus later file', { skip: !enabled }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.migrations, '0001_must_not_execute.sql'),
    "DO $$ BEGIN RAISE EXCEPTION 'START_AT ignored'; END $$;\n");
  f.run('pg', [], 'push-hosted-migrations.js', { START_AT: migration });
  await f.assertDetached();
  assert.deepEqual((await f.client.query('SELECT value FROM timeout_observations')).rows, [{ value: '7s' }]);
});
