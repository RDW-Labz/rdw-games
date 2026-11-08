// scripts/mega-sim/personas/photographer.js
//
// Persona: exercises the photo-URL boundary that the audit flagged as
// untested. The user-facing upload failure modes (413, network mid-
// upload, malformed signed URL) live in the HTTP/client layer and
// can't be reached from a DB-only sim — but the SECURITY-relevant
// boundary lives in the database:
//
//   • is_safe_image_url(text)            — 0038/0045 allowlist function
//   • lots_filter_photo_urls trigger     — 0049 strips unsafe URLs on
//                                          INSERT/UPDATE OF photo_urls
//
// The trigger is silent-strip not reject. Apps trust the trigger as the
// final gate. If the allowlist regresses (e.g. a CDN gets dropped from
// the IN-clause), every Quick Lot photo from that CDN starts silently
// vanishing — bidder lots become photoless. That's the failure this
// persona is here to catch BEFORE the user notices.
//
// Tests:
//   1. Safe-only URL list → preserved verbatim.
//   2. Mixed safe + unsafe → only safe kept.
//   3. All-unsafe → empty array (not NULL, the trigger normalizes).
//   4. UPDATE with new unsafe URLs → trigger strips on update too.
//   5. Edge cases: NULL → []; non-https → stripped; allowlist host.
//
// Doesn't depend on Phase 1 state — creates its own throwaway test lot
// via create_draft_lot, mutates photo_urls directly via service-role
// to exercise the trigger, then leaves the lot for sim cleanup.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

// Representative URLs. These are HOSTS only; the trigger checks the
// hostname-portion match, not the full URL. Any path suffix works.
const SAFE_URLS = [
  'https://m.media-amazon.com/images/I/safe1.jpg',
  'https://images.thdstatic.com/safe2.jpg',
  'https://i5.walmartimages.com/safe3.jpg',
  'https://xgsujdzicnjenhqihovk.supabase.co/storage/v1/object/public/lot-photos/safe4.jpg',
];

const UNSAFE_URLS = [
  'https://evil.example.com/bad1.jpg',
  'http://m.media-amazon.com/insecure.jpg', // http not https
  'https://i.imgur.com/bad2.png',
  'https://random.cdn/image.gif',
  'data:image/png;base64,iVBORw0KG',
  'javascript:alert(1)',
  '',
];

async function run({ ctx }) {
  setPhase('Photographer');

  // ── Mint a test lot we'll mutate ─────────────────────────────────────
  let lotId = null;
  let lotCode = null;
  await step('mint a fresh test lot for photo trigger exercises', async () => {
    const { value } = await time('rpc.create_draft_lot.photoTest', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim photo trigger test',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 100,
        p_starting_bid_cents: 100,
        p_photo_urls: [], // start clean; we'll set them via UPDATE
        p_external_code: 'SIM-PHOTO-' + Date.now(),
        p_source: 'sim',
      }),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    lotId = row.out_id;
    lotCode = row.out_lot_code;
  });

  // ── Safe URLs only → preserved verbatim ──────────────────────────────
  await step('UPDATE with all-safe URLs preserves the full list', async () => {
    const { value } = await time('supa.update.lots.photoSafeOnly', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=eq.' + lotId,
        { photo_urls: SAFE_URLS },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data[0].photo_urls.length).toBe(SAFE_URLS.length);
    // Order is preserved by the trigger (it uses array_agg in PostgreSQL
    // which respects input order when no ORDER BY is specified — true
    // for unnest+filter pipelines in current PG versions).
    for (const u of SAFE_URLS) {
      expect(value.data[0].photo_urls.includes(u)).toBe(true);
    }
  });

  // ── Mixed safe + unsafe → unsafe stripped, safe kept ─────────────────
  await step('UPDATE with mixed URLs strips unsafe, keeps safe', async () => {
    const mixed = [];
    // Interleave so we'd catch off-by-one bugs in the filter loop.
    for (let i = 0; i < Math.max(SAFE_URLS.length, UNSAFE_URLS.length); i += 1) {
      if (UNSAFE_URLS[i]) mixed.push(UNSAFE_URLS[i]);
      if (SAFE_URLS[i]) mixed.push(SAFE_URLS[i]);
    }
    const { value } = await time('supa.update.lots.photoMixed', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=eq.' + lotId,
        { photo_urls: mixed },
        true,
      ),
    );
    expect(value.error).toBeNull();
    const got = value.data[0].photo_urls;
    expect(got.length).toBe(SAFE_URLS.length);
    for (const u of SAFE_URLS) expect(got.includes(u)).toBe(true);
    for (const u of UNSAFE_URLS) expect(got.includes(u)).toBe(false);
  });

  // ── All-unsafe → empty array (NOT null, NOT a failure) ───────────────
  await step('UPDATE with all-unsafe URLs results in empty array', async () => {
    const { value } = await time('supa.update.lots.photoAllUnsafe', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=eq.' + lotId,
        { photo_urls: UNSAFE_URLS },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data[0].photo_urls)).toBe(true);
    expect(value.data[0].photo_urls.length).toBe(0);
  });

  // ── NULL photo_urls normalizes to empty array ────────────────────────
  // PostgREST sends explicit NULL as JSON null. Trigger's NEW.photo_urls
  // IS NULL branch should normalize to []. NOT NULL column constraint
  // would otherwise reject this.
  await step('UPDATE with NULL photo_urls normalizes to empty array', async () => {
    const { value } = await time('supa.update.lots.photoNull', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=eq.' + lotId,
        { photo_urls: null },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data[0].photo_urls)).toBe(true);
    expect(value.data[0].photo_urls.length).toBe(0);
  });

  // ── INSERT path: trigger fires on initial photo_urls too ────────────
  // Mint a second lot via direct service-role INSERT (bypassing
  // create_draft_lot, which always passes []). Trigger should strip
  // unsafe URLs before the row commits.
  await step('INSERT path: trigger strips unsafe URLs at row creation', async () => {
    // create_draft_lot ignores p_photo_urls? Let me find out — actually
    // looking at 0048, create_draft_lot DOES set photo_urls from
    // p_photo_urls. So pass a mixed array and verify the trigger filtered.
    const mixed = [SAFE_URLS[0], UNSAFE_URLS[0], SAFE_URLS[1], UNSAFE_URLS[1]];
    const { value } = await time('rpc.create_draft_lot.photoTriggerOnInsert', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim photo INSERT trigger test',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 100,
        p_starting_bid_cents: 100,
        p_photo_urls: mixed,
        p_external_code: 'SIM-PHOTO2-' + Date.now(),
        p_source: 'sim',
      }),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    const insertLotId = row.out_id;

    const fetched = await supa.supaSelect(
      ctx.adminToken,
      'lots',
      'id=eq.' + insertLotId,
      'photo_urls',
    );
    expect(fetched.error).toBeNull();
    const got = fetched.data[0].photo_urls;
    expect(got.length).toBe(2);
    expect(got.includes(SAFE_URLS[0])).toBe(true);
    expect(got.includes(SAFE_URLS[1])).toBe(true);
    expect(got.includes(UNSAFE_URLS[0])).toBe(false);
    expect(got.includes(UNSAFE_URLS[1])).toBe(false);
  });

  // ── is_safe_image_url() RPC contract ─────────────────────────────────
  // The trigger trusts is_safe_image_url. If this function is exposed
  // via PostgREST it lets us unit-test the allowlist directly. If it
  // isn't exposed, skip (the trigger above is the integration test).
  await step('is_safe_image_url returns expected booleans (best-effort)', async () => {
    const checks = [
      { url: 'https://m.media-amazon.com/x.jpg', expected: true },
      { url: 'https://i.ebayimg.com/x.jpg', expected: true },
      { url: 'https://evil.example.com/x.jpg', expected: false },
      { url: 'http://m.media-amazon.com/x.jpg', expected: false }, // http
      { url: '', expected: false },
    ];
    let exposed = true;
    for (const c of checks) {
      const { value } = await time('rpc.is_safe_image_url', () =>
        supa.supaRpc(null, 'is_safe_image_url', { p_url: c.url }, true),
      );
      if (value.error) {
        // PostgREST may refuse to expose IMMUTABLE STRICT helpers;
        // that's fine — record best-effort and continue.
        exposed = false;
        break;
      }
      expect(value.data).toBe(c.expected);
    }
    if (!exposed) {
      console.log('      [photographer] is_safe_image_url not exposed via PostgREST; trigger-side coverage is the binding test.');
    }
  });
}

module.exports = { run };
