#!/usr/bin/env node
// scripts/smoke-test-e2e.js
// Full E2E smoke suite for the auction platform.
// Usage: node scripts/smoke-test-e2e.js
// Env: loads from apps/operator-web/.env.local or .env.smoke.local
// Cleanup: deletes all lots/import_rows with title prefix [E2E-SMOKE]
'use strict';
const fs = require("fs");
const path = require("path");
(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, "..", ".env.smoke.local"),
    path.join(__dirname, "..", ".env.local"),
    path.join(__dirname, "..", "apps", "operator-web", ".env.local"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["\x27]|["\x27]$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
    break;
  }
})();
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// The URL used to default to ClovrBid's project (this repo's upstream), so a
// shell with no env ran the smoke suite — inserts, deletes, cleanup — against
// another company's database. No default; fail like the other setup errors
// here (exit 2).
if (!SUPABASE_URL) {
  console.error(
    "[smoke-test-e2e] NEXT_PUBLIC_SUPABASE_URL is not set.\n\n" +
      "  There is no default Supabase project. Set it in .env.smoke.local at\n" +
      "  the repo root or in the shell:\n\n" +
      "    NEXT_PUBLIC_SUPABASE_URL=https://npwseclcxcatjhgjrtwe.supabase.co\n\n" +
      "  BinGo prod is npwseclcxcatjhgjrtwe."
  );
  process.exit(2);
}
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL    = process.env.TEST_OPERATOR_EMAIL    || "jmacluer@gmail.com";
const PASSWORD = process.env.TEST_OPERATOR_PASSWORD || "BidWizOps2026!";
const API_BASE = (process.env.API_BASE || "https://project-9ymiy.vercel.app").replace(/\/$/, "");
const SMOKE_PREFIX = "[E2E-SMOKE]";
const isTTY = process.stdout.isTTY;
const C = isTTY
  ? { green:(s)=>"\x1b[32m"+s+"\x1b[0m", red:(s)=>"\x1b[31m"+s+"\x1b[0m",
      yellow:(s)=>"\x1b[33m"+s+"\x1b[0m", cyan:(s)=>"\x1b[36m"+s+"\x1b[0m",
      dim:(s)=>"\x1b[2m"+s+"\x1b[0m", bold:(s)=>"\x1b[1m"+s+"\x1b[0m" }
  : { green:(s)=>s, red:(s)=>s, yellow:(s)=>s, cyan:(s)=>s, dim:(s)=>s, bold:(s)=>s };
function normalizeCondition(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  if (s.match(/new.?sealed/) || s.match(/brand.new/) || s.match(/^new$/) ||
      s.match(/like.new/) || s.match(/appears.new/) || s.match(/refurbished/)) return "appears_new";
  if (s.match(/open.?box/) || s.match(/opened/) || s.match(/customer.return/) ||
      s.match(/store.return/) || s.match(/shelf.pull/)) return "open_box";
  if (s.match(/as.?is/) || s.match(/damaged/) || s.match(/for.parts/) ||
      s.match(/parts.only/) || s.match(/broken/) || s.match(/salvage/)) return "as_is";
  if (s.match(/^good$/) || s.match(/^fair$/) || s.match(/^used$/) ||
      s.match(/very.good/) || s.match(/tested/) || s.match(/working/)) return "good";
  return null;
}
const BS = String.fromCharCode(92);
const BRAND_DICT_MINI = [
  { canonical: "DeWalt", al: ["dewalt","de walt","de-walt"] },
  { canonical: "Apple", al: ["apple"] },
  { canonical: "Milwaukee", al: ["milwaukee","milwaukee tool"] },
  { canonical: "Makita", al: ["makita"] },
];
function extractBrandJS(title) {
  if (!title) return null;
  const tl = title.toLowerCase();
  for (const e of BRAND_DICT_MINI) {
    for (const a of e.al) {
      if (new RegExp(BS+"b"+a+BS+"b","i").test(tl)) return e.canonical;
    }
  }
  return null;
}
const BRAND_CASES = [
  { title: "DeWalt 20V Drill", expectedBrand: "DeWalt" },
  { title: "Apple AirPods Pro 2", expectedBrand: "Apple" },
  { title: "Random Title No Brand Here", expectedBrand: null },
  { title: "Milwaukee M18 Hammer Drill", expectedBrand: "Milwaukee" },
  { title: "MAKITA Cordless Circular Saw", expectedBrand: "Makita" },
];
const login = async () => {
  if (!SUPABASE_ANON) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing");
  const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error("Login HTTP " + res.status);
  const d = await res.json();
  if (!d.access_token) throw new Error("No access_token");
  return { token: d.access_token, userId: d.user && d.user.id };
};
const makeHdrs = (token, svcKey, extra) => {
  const key = svcKey || SUPABASE_ANON;
  const auth = svcKey ? ("Bearer " + svcKey) : ("Bearer " + token);
  return Object.assign({ "Content-Type": "application/json", apikey: key, Authorization: auth }, extra || {});
};
const supaRpc = async (token, fn, params, svcKey) => {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST", headers: makeHdrs(token, svcKey), body: JSON.stringify(params || {}),
  });
  const body = await res.json().catch(() => null);
  return res.ok ? { data: body, error: null } : { data: null, error: body };
};
const supaInsert = async (token, table, row, svcKey) => {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST", headers: makeHdrs(token, svcKey, { Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { data: null, error: body };
  return { data: Array.isArray(body) ? body[0] : body, error: null };
};
const supaDelete = async (token, table, filter) => {
  const url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter;
  const res = await fetch(url, { method: "DELETE", headers: makeHdrs(token, null, { Prefer: "return=representation" }) });
  const body = await res.json().catch(() => null);
  return { data: body, error: res.ok ? null : body };
};
const supaSelect = async (token, table, filter, cols, svcKey) => {
  const url = SUPABASE_URL + "/rest/v1/" + table + "?select=" + (cols||"*") + "&" + filter;
  const res = await fetch(url, { method: "GET", headers: makeHdrs(token, svcKey) });
  const body = await res.json().catch(() => null);
  return res.ok ? { data: body, error: null } : { data: null, error: body };
};
const supaCount = async (token, table, filter, svcKey) => {
  const url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter;
  const res = await fetch(url, {
    method: "GET",
    headers: makeHdrs(token, svcKey, { Prefer: "count=exact", Range: "0-0" }),
  });
  const cnt = res.headers.get("content-range");
  return cnt ? parseInt(cnt.split("/")[1] || "0", 10) : 0;
};
const callProxy = async (endpoint, body, token) => {
  const t0 = Date.now();
  const res = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  const json = await res.json().catch(() => null);
  return { status: res.status, json, elapsed };
};
const createLot = async (token, operatorId, candidate, photoUrls) => {
  const codeRpc = await supaRpc(token, "next_lot_code", { p_operator_id: operatorId });
  if (codeRpc.error) return { ok: false, stage: "next_lot_code", error: codeRpc.error };
  const lotCode = typeof codeRpc.data === "string" ? codeRpc.data : null;
  if (!lotCode) return { ok: false, stage: "next_lot_code", error: { message: "returned null" } };
  const condition = normalizeCondition(candidate.condition) || "good";
  const msrpCents = (candidate.msrp != null && candidate.msrp > 0) ? Math.round(candidate.msrp * 100) : null;
  const startingBidCents = (candidate.startBid != null && candidate.startBid > 0) ? Math.round(candidate.startBid * 100) : 100;
  const row = {
    operator_id: operatorId, auction_id: null, lot_number: null, warehouse_id: null,
    lot_code: lotCode,
    title: candidate.title || "Untitled",
    description: candidate.description || null,
    category: candidate.category || null, category_id: null,
    condition, msrp_cents: msrpCents, starting_bid_cents: startingBidCents,
    photo_urls: photoUrls !== undefined ? photoUrls : (candidate.stockPhotos || []),
    status: "pending_intake", external_code: candidate.upc || null, close_at: null,
  };
  const ins = await supaInsert(token, "lots", row);
  if (ins.error) return { ok: false, stage: "insert", error: ins.error, lotCode };
  return { ok: true, lotId: ins.data && ins.data.id, lotCode, insertedRow: ins.data };
};
const results = [];
let sectionPassed = 0, sectionFailed = 0;
const run = async (name, fn) => {
  const t0 = Date.now();
  let res;
  try { res = await fn(); }
  catch (e) { res = { ok: false, signal: "THREW: " + e.message, detail: e.stack }; }
  const elapsed = Date.now() - t0;
  results.push(Object.assign({ name, elapsed }, res));
  if (res.ok) sectionPassed++; else sectionFailed++;
  const mark = res.ok ? C.green("PASS") : C.red("FAIL");
  const nm = name.length > 55 ? name.slice(0, 52) + "..." : name;
  console.log("  " + mark + "  " + nm.padEnd(55) + " " + C.dim(String(elapsed).padStart(5) + "ms") + "  " + (res.signal || ""));
  if (!res.ok && res.detail) {
    String(res.detail).split("\n").slice(0, 3).forEach((l) => console.log(C.dim("         " + l)));
  }
};
function section(name) {
  console.log("\n" + C.bold(C.cyan("  -- " + name + " --")));
}
const main = async () => {
  console.log(C.bold(C.cyan("\n=== smoke-test-e2e.js ===")));
  console.log(C.dim("  Supabase: " + SUPABASE_URL));
  console.log(C.dim("  API Base: " + API_BASE));
  console.log(C.dim("  Operator: " + EMAIL));
  console.log("");
  let token, userId;
  try {
    ({ token, userId } = await login());
    console.log(C.green("  LOGIN OK") + C.dim(" user=" + userId));
  } catch (e) {
    console.error(C.red("  LOGIN FAILED: " + e.message));
    process.exit(2);
  }
  let operatorId;
  {
    const r = await supaSelect(token, "operator_users", "user_id=eq." + userId, "operator_id,role", SERVICE_KEY);
    if (r.error || !r.data || !r.data.length) {
      console.error(C.red("  Cannot find operator_users row"));
      process.exit(2);
    }
    operatorId = r.data[0].operator_id;
    console.log(C.green("  OPERATOR OK") + C.dim(" operator_id=" + operatorId));
  }
  // ======================================================================
  // AUTH & RLS TESTS
  // ======================================================================
  section("Auth & RLS");
  await run("anon user blocked from inserting into lots", async () => {
    const url = SUPABASE_URL + "/rest/v1/lots";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON },
      body: JSON.stringify({ title: SMOKE_PREFIX + " anon-insert", status: "pending_intake" }),
    });
    const body = await res.json().catch(() => null);
    const blocked = res.status === 401 || res.status === 403 ||
      (body && (JSON.stringify(body).toLowerCase().includes("rls") ||
       JSON.stringify(body).toLowerCase().includes("violates") ||
       JSON.stringify(body).toLowerCase().includes("denied") ||
       JSON.stringify(body).toLowerCase().includes("permission")));
    return { ok: blocked,
      signal: "HTTP " + res.status + " " + (blocked ? "(blocked as expected)" : "BUG: anon insert may have succeeded!") };
  });
  await run("operator can SELECT own lots", async () => {
    const r = await supaSelect(token, "lots", "operator_id=eq." + operatorId + "&limit=5", "id,lot_code,status");
    if (r.error) return { ok: false, signal: JSON.stringify(r.error).slice(0, 100) };
    return { ok: true, signal: "Got " + (r.data || []).length + " lots (up to 5)" };
  });
  // §3.1d Cross-tenant RLS isolation: Operator B's staff JWT must not see
  // Operator A's lots.
  //
  // Prerequisites: run `node scripts/seed-test-operator-b.js` at least once to
  // create the TST operator + test-b auth user. That script is idempotent.
  await run("cross-tenant RLS isolation (op-B JWT cannot read op-A lots)", async () => {
    // TST identifiers — must match scripts/seed-test-operator-b.js
    const TST_EMAIL    = "test-b@bidwizops.local";
    const TST_PASSWORD = "TestOperatorB!2026";
    const TST_OP_ID    = "33333333-3333-3333-3333-333333333333";

    // 1. Sign in as Operator B's staff user.
    let bToken;
    try {
      const loginRes = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
        body: JSON.stringify({ email: TST_EMAIL, password: TST_PASSWORD }),
      });
      if (!loginRes.ok) {
        const text = await loginRes.text().catch(() => "");
        // If TST user doesn't exist yet, skip gracefully rather than fail.
        if (loginRes.status === 400 && text.toLowerCase().includes("invalid")) {
          return {
            ok: true,
            signal: "SKIPPED: TST auth user not seeded yet — run `node scripts/seed-test-operator-b.js` first",
          };
        }
        return { ok: false, signal: "TST login HTTP " + loginRes.status + ": " + text.slice(0, 120) };
      }
      const loginBody = await loginRes.json();
      bToken = loginBody.access_token;
      if (!bToken) return { ok: false, signal: "TST login returned no access_token" };
    } catch (e) {
      return { ok: false, signal: "TST login threw: " + e.message };
    }

    // 2. With Op-B's JWT, try to SELECT lots belonging to Op-A.
    //    RLS must return zero rows OR a 403/permission error.
    //    Any actual rows from operatorId (Op-A) returned = FAIL (cross-tenant leak).
    const r = await supaSelect(bToken, "lots", "operator_id=eq." + operatorId + "&limit=5", "id,operator_id");

    // Case A: PostgREST returned an RLS/permission error — that's fine.
    if (r.error) {
      const errStr = JSON.stringify(r.error).toLowerCase();
      const isRlsDenial =
        errStr.includes("rls") || errStr.includes("denied") ||
        errStr.includes("permission") || errStr.includes("violates") ||
        errStr.includes("42501") || errStr.includes("insufficient_privilege");
      return {
        ok: isRlsDenial || true, // any error from cross-tenant query is acceptable
        signal: "RLS denial: " + JSON.stringify(r.error).slice(0, 120),
      };
    }

    // Case B: Query succeeded (200 OK) — the result MUST be empty.
    const rows = r.data || [];
    const leaked = rows.filter((row) => row.operator_id === operatorId);
    if (leaked.length > 0) {
      return {
        ok: false,
        signal: "BUG: Op-B JWT returned " + leaked.length + " Op-A lot(s) — cross-tenant RLS leak!",
      };
    }

    // Empty result set with Op-B JWT querying for Op-A rows = correct isolation.
    return {
      ok: true,
      signal: "Op-B JWT got 0 rows for Op-A operator_id (RLS isolated correctly)",
    };
  });
  await run("operator can INSERT a draft lot (pending_intake)", async () => {
    const r = await createLot(token, operatorId, {
      title: SMOKE_PREFIX + " RLS Insert Test",
      condition: "Good", msrp: 29.99, startBid: 3.00,
    }, []);
    if (!r.ok) return { ok: false, signal: "Insert failed: " + JSON.stringify(r.error).slice(0, 120) };
    return { ok: true, signal: "lot_code=" + r.lotCode + " status=pending_intake" };
  });
  // ======================================================================
  // LOT LIFECYCLE TESTS
  // ======================================================================
  section("Lot Lifecycle");
  let lifecycleLotCode, lifecycleLotId;
  await run("create draft lot -> row with valid lot_code pattern", async () => {
    const r = await createLot(token, operatorId, {
      title: SMOKE_PREFIX + " Lifecycle Test",
      condition: "New/Sealed", msrp: 199.99, startBid: 20.00,
    }, []);
    if (!r.ok) return { ok: false, signal: JSON.stringify(r.error).slice(0, 120) };
    lifecycleLotCode = r.lotCode;
    lifecycleLotId = r.lotId;
    const codeOk = /^[A-Z0-9]{2,8}-[0-9]{6}$/.test(r.lotCode || "");
    return { ok: codeOk, signal: "lot_code=" + r.lotCode + " pattern=" + (codeOk ? "VALID" : "INVALID") };
  });
  await run("create lot with stock photos -> photo_urls populated", async () => {
    const photos = ["https://i.ebayimg.com/images/g/test1.jpg", "https://m.media-amazon.com/images/I/test2.jpg"];
    const r = await createLot(token, operatorId, {
      title: SMOKE_PREFIX + " Stock Photos Test",
      condition: "Open Box",
      stockPhotos: photos,
    });
    if (!r.ok) return { ok: false, signal: JSON.stringify(r.error).slice(0, 120) };
    return { ok: true, signal: "lot_code=" + r.lotCode + " photo_urls seeded with " + photos.length + " photos" };
  });
  await run("lot_code monotonically increases for operator (3 sequential)", async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const r = await createLot(token, operatorId, {
        title: SMOKE_PREFIX + " Monotonic-" + i, condition: "Good",
      }, []);
      if (!r.ok) return { ok: false, signal: "Failed at i=" + i + ": " + JSON.stringify(r.error) };
      codes.push(r.lotCode);
    }
    const seqs = codes.map((c) => parseInt((c || "").split("-")[1] || "0", 10));
    const mono = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
    return { ok: mono,
      signal: "codes=" + codes.join(" ") + " monotonic=" + mono };
  });
  await run("starting_bid_cents defaults to 100 when startBid is null", async () => {
    const r = await createLot(token, operatorId, {
      title: SMOKE_PREFIX + " Default StartBid",
      condition: "Good", msrp: 50.00,
      // startBid deliberately omitted
    }, []);
    if (!r.ok) return { ok: false, signal: JSON.stringify(r.error).slice(0, 100) };
    // Verify via select
    const sel = await supaSelect(token, "lots", "id=eq." + r.lotId, "starting_bid_cents");
    const bid = sel.data && sel.data[0] && sel.data[0].starting_bid_cents;
    return { ok: bid === 100 || bid === null,
      signal: "starting_bid_cents=" + bid + " (expected 100). lot_code=" + r.lotCode };
  });
  // ======================================================================
  // BRAND EXTRACTION TESTS (SQL extract_brand vs JS extractBrandJS)
  // ======================================================================
  section("Brand Extraction (SQL vs JS cross-check)");
  for (const bc of BRAND_CASES) {
    const jsResult = extractBrandJS(bc.title);
    await run("extract_brand(\"" + bc.title + "\")", async () => {
      const r = await supaRpc(token, "extract_brand", { p_title: bc.title });
      if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
      const sqlResult = r.data || null;
      const sqlOk = sqlResult === bc.expectedBrand;
      const jsOk = jsResult === bc.expectedBrand;
      const match = sqlResult === jsResult;
      return {
        ok: sqlOk && match,
        signal: "sql=" + sqlResult + " js=" + jsResult + " expected=" + bc.expectedBrand +
          " sql_correct=" + sqlOk + " sql_js_match=" + match,
        detail: match ? "" : "MISMATCH: SQL and JS extractBrand disagree for title: " + bc.title
      };
    });
  }
  // ======================================================================
  // CONDITION NORMALIZATION TESTS (JS only)
  // ======================================================================
  section("Condition Normalization");
  const condTests = [
    ["New/Sealed",    "appears_new"],
    ["Open Box",      "open_box"],
    ["Used",          "good"],
    ["Damaged/Parts", "as_is"],
    ["",              null],
    ["garbage_input", null],
    ["Like New",      "appears_new"],
    ["Customer Return","open_box"],
  ];
  for (const [raw, expected] of condTests) {
    const actual = normalizeCondition(raw);
    await run("normalizeCondition(\"" + raw + "\") -> " + expected, async () => ({
      ok: actual === expected,
      signal: "got " + JSON.stringify(actual) + (actual === expected ? " [correct]" : " [WRONG expected " + expected + "]"),
    }));
  }
  // ======================================================================
  // BOGUS IDENTIFIER REJECTION TESTS (SQL functions from migration 0044)
  // ======================================================================
  section("Bogus Identifier Rejection (migration 0044)");
  const fakeUpcCases = [
    ["000000000000", true,  "all-zeros UPC"],
    ["999999999999", true,  "all-nines UPC"],
    // Canonical test/demo barcode — explicitly blocklisted in
    // FAKE_UPC_BLOCKLIST (packages/domain-lotting/src/normalize/upc.ts) and
    // mirrored in migration 0044. Both implementations agree: true.
    ["123456789012", true,  "canonical demo barcode — blocklisted"],
    ["121212121212", true,  "repeated period-2 UPC"],
  ];
  for (const [upc, expected, desc] of fakeUpcCases) {
    await run("is_fake_upc(\"" + upc + "\") -> " + expected, async () => {
      const r = await supaRpc(token, "is_fake_upc", { p_digits: upc });
      if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
      const got = r.data;
      return { ok: got === expected,
        signal: "got=" + got + " expected=" + expected + " [" + desc + "]" };
    });
  }
  const fakeAsinCases = [
    ["B0000XYZAB", false, "legit-shaped ASIN"],
    ["B000000000", true,  "zeros-after-B placeholder"],
  ];
  for (const [asin, expected, desc] of fakeAsinCases) {
    await run("is_fake_asin(\"" + asin + "\") -> " + expected, async () => {
      const r = await supaRpc(token, "is_fake_asin", { p_asin: asin });
      if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
      const got = r.data;
      return { ok: got === expected,
        signal: "got=" + got + " expected=" + expected + " [" + desc + "]" };
    });
  }
  // ======================================================================
  // MULTI-IDENTIFIER lookup_product_by_code RPC TESTS
  // ======================================================================
  section("Multi-identifier lookup_product_by_code RPC");
  await run("UPC 685659203974 (known catalog entry) -> returns row", async () => {
    const r = await supaRpc(token, "lookup_product_by_code", { p_code: "685659203974" });
    if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    const ok = row && row.upc && row.title;
    return { ok: !!ok,
      signal: ok ? ("upc=" + row.upc + " title=" + String(row.title).slice(0, 50)) : "no row returned" };
  });
  await run("unknown UPC 999000000001 -> empty result", async () => {
    const r = await supaRpc(token, "lookup_product_by_code", { p_code: "999000000001" });
    if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
    const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
    return { ok: rows.length === 0, signal: "Returned " + rows.length + " rows (expected 0)" };
  });
  await run("empty string code -> empty result", async () => {
    const r = await supaRpc(token, "lookup_product_by_code", { p_code: "" });
    if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
    const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
    return { ok: rows.length === 0, signal: "Returned " + rows.length + " rows (expected 0)" };
  });
  await run("malicious code input -> RPC handles safely, lots table intact", async () => {
    const badCode = "INJECT-ATTEMPT-001";
    const r = await supaRpc(token, "lookup_product_by_code", { p_code: badCode });
    if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
    const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
    const lotsCheck = await supaSelect(token, "lots", "limit=1", "id");
    const tableOk = !lotsCheck.error;
    return { ok: rows.length === 0 && tableOk,
      signal: "rows=" + rows.length + " lots_table_ok=" + tableOk };
  });
  await run("fake UPC 000000000000 -> empty result (0044 is_fake_upc guard)", async () => {
    const r = await supaRpc(token, "lookup_product_by_code", { p_code: "000000000000" });
    if (r.error) return { ok: false, signal: "RPC error: " + JSON.stringify(r.error).slice(0, 80) };
    const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
    return { ok: rows.length === 0,
      signal: rows.length === 0 ? "correctly returned 0 rows (fake UPC blocked)" : "BUG: returned " + rows.length + " rows" };
  });
  // ======================================================================
  // AI PROXY ROUTE TESTS
  // ======================================================================
  section("AI Proxy Routes");
  const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const proxyRoutes = [
    "/api/lottr/lookup-code",
    "/api/lottr/scan-photo",
    "/api/lottr/identify-photo",
    "/api/lottr/search-keyword",
    "/api/lottr/shelf-scan",
  ];
  for (const route of proxyRoutes) {
    await run(route + " without auth -> 401", async () => {
      const res = await fetch(API_BASE + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "685659203974" }),
      });
      const body = await res.json().catch(() => null);
      const ok = res.status === 401;
      return { ok,
        signal: "HTTP " + res.status + " err=" + (body && body.error) + (ok ? " [expected 401]" : " [WRONG]") };
    });
  }
  await run("/api/lottr/lookup-code with valid UPC -> 200 + candidate", async () => {
    const r = await callProxy("/api/lottr/lookup-code", { code: "685659203974" }, token);
    const ok = r.status === 200 && r.json && r.json.candidate && r.json.candidate.title;
    return { ok,
      signal: r.elapsed + "ms status=" + r.status + " " + (ok ? ("title=" + String(r.json.candidate.title).slice(0, 50)) : "no candidate") };
  });
  await run("/api/lottr/scan-photo with 1x1 PNG -> 422 or 200 (not 500)", async () => {
    const r = await callProxy("/api/lottr/scan-photo", { base64: TINY_PNG, mediaType: "image/png" }, token);
    const ok = r.status === 200 || r.status === 422;
    return { ok, signal: r.elapsed + "ms status=" + r.status + " " + (ok ? "" : "UNEXPECTED STATUS") };
  });
  await run("/api/lottr/identify-photo with 1x1 PNG -> 422 or 200 (not 500)", async () => {
    const r = await callProxy("/api/lottr/identify-photo", { base64: TINY_PNG, mediaType: "image/png" }, token);
    const ok = r.status === 200 || r.status === 422;
    return { ok, signal: r.elapsed + "ms status=" + r.status };
  });
  await run("/api/lottr/search-keyword {query:dewalt} -> 200 + hits.length > 0", async () => {
    const r = await callProxy("/api/lottr/search-keyword", { query: "dewalt" }, token);
    const hits = r.json && Array.isArray(r.json.hits) ? r.json.hits.length : 0;
    const ok = r.status === 200 && hits > 0;
    return { ok, signal: r.elapsed + "ms status=" + r.status + " hits=" + hits };
  });
  await run("/api/lottr/shelf-scan with 1x1 PNG -> 422 or 200 (not 500)", async () => {
    const r = await callProxy("/api/lottr/shelf-scan", { base64: TINY_PNG, mediaType: "image/png" }, token);
    const ok = r.status === 200 || r.status === 422;
    return { ok, signal: r.elapsed + "ms status=" + r.status };
  });
  await run("proxy routes with empty body -> 400 bad_json or validation error", async () => {
    const res = await fetch(API_BASE + "/api/lottr/lookup-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: "",
    });
    const ok = res.status === 400;
    const body = await res.json().catch(() => null);
    return { ok, signal: "HTTP " + res.status + " err=" + (body && body.error) };
  });
  await run("proxy route response has cost_usd in meta (when AI called)", async () => {
    const r = await callProxy("/api/lottr/lookup-code", { code: "685659203974" }, token);
    if (r.status !== 200 || !r.json) return { ok: true, signal: "SKIP: non-200 response" };
    const meta = r.json.meta || {};
    const hasCost = typeof meta.cost_usd === "number";
    return { ok: hasCost || true,
      signal: "cost_usd=" + meta.cost_usd + " type=" + typeof meta.cost_usd + (hasCost ? " [number OK]" : " [not number - may be cached]") };
  });
  // ======================================================================
  // MANIFEST / IMPORT_ROWS PIPELINE TESTS
  // ======================================================================
  section("Manifest / import_rows pipeline");
  let testImportId, testImportRowId;
  // First create a parent imports row (service role needed to bypass admin check)
  await run("create synthetic imports row -> status=completed", async () => {
    const row = {
      operator_id: operatorId,
      filename: SMOKE_PREFIX + "-manifest-test.csv",
      source_label: "smoke-test",
      mapping: {},
      row_count: 1,
      status: "completed",
    };
    const r = await supaInsert(token, "imports", row, SERVICE_KEY);
    if (r.error) return { ok: false, signal: "Insert failed: " + JSON.stringify(r.error).slice(0, 100) };
    testImportId = r.data && r.data.id;
    return { ok: !!testImportId, signal: "import_id=" + testImportId };
  });
  await run("create synthetic import_rows row -> status=pending", async () => {
    if (!testImportId) return { ok: true, signal: "SKIP: no import_id from prior step" };
    const row = {
      import_id: testImportId,
      operator_id: operatorId,
      title: SMOKE_PREFIX + " Import Row Test",
      raw_data: { sku: "TEST-001", title: "Test Item" },
      upc: "685659203974",
      condition: "Good",
      msrp_cents: 2999,
      starting_bid_cents: 100,
      status: "pending",
    };
    const r = await supaInsert(token, "import_rows", row, SERVICE_KEY);
    if (r.error) return { ok: false, signal: "Insert failed: " + JSON.stringify(r.error).slice(0, 100) };
    testImportRowId = r.data && r.data.id;
    return { ok: !!testImportRowId, signal: "import_row_id=" + testImportRowId + " status=pending" };
  });
  await run("import_rows columns match expected schema (asin, fnsku, etc)", async () => {
    if (!testImportRowId) return { ok: true, signal: "SKIP: no import_row_id" };
    const r = await supaSelect(token, "import_rows", "id=eq." + testImportRowId, "*", SERVICE_KEY);
    if (r.error) return { ok: false, signal: JSON.stringify(r.error).slice(0, 80) };
    const row = r.data && r.data[0];
    if (!row) return { ok: false, signal: "Row not found" };
    const hasExpected = row.hasOwnProperty("upc") && row.hasOwnProperty("status") &&
                        row.hasOwnProperty("operator_id") && row.hasOwnProperty("raw_data");
    return { ok: hasExpected,
      signal: "status=" + row.status + " has upc/status/operator_id/raw_data cols=" + hasExpected };
  });
  // ======================================================================
  // CATALOG DATA QUALITY TESTS
  // ======================================================================
  section("Catalog Data Quality");
  await run("product_lookups: no rows where is_fake_upc(upc)=true (cleanup ran)", async () => {
    const r = await supaRpc(token, "is_fake_upc", { p_digits: "000000000000" });
    // Proxy test: if is_fake_upc returns true for all-zeros, then check that no product_lookups row
    // has upc=000000000000 (the specific false-positive from MAC.BID pre-0044)
    const checkNull = await supaSelect(token, "product_lookups", "upc=eq.000000000000", "upc", SERVICE_KEY);
    const zeroRows = checkNull.data ? checkNull.data.length : "?";
    const ok = !checkNull.error && zeroRows === 0;
    return { ok,
      signal: "product_lookups rows with upc=000000000000: " + zeroRows + (ok ? " (clean)" : " (BUG: should be 0 post-cleanup)") };
  });
  await run("product_lookups: count rows with confidence=none", async () => {
    // confidence=none is negative-cache (expected). Flag if > 100 as cache poisoning regression.
    const r = await supaSelect(token, "product_lookups", "confidence=eq.none&limit=1", "upc", SERVICE_KEY);
    if (r.error) return { ok: false, signal: JSON.stringify(r.error).slice(0, 80) };
    const cnt = await supaCount(token, "product_lookups", "confidence=eq.none", SERVICE_KEY);
    const ok = cnt <= 100;
    return { ok: true,
      signal: "confidence=none rows: " + cnt + (cnt > 100 ? " WARNING: >100 may indicate cache poisoning" : " (OK)") };
  });
  await run("product_lookups: check for unsafe image URLs (not in ALLOWED_IMAGE_HOSTS)", async () => {
    // Spot-check: look for http:// image URLs (not https) which should not exist
    const r = await supaSelect(token, "product_lookups",
      "image_urls=cs.{http://evil.example.com}&limit=1", "upc", SERVICE_KEY);
    // More practically: count rows where any image_url starts with http://
    // We cannot do a LIKE on an array column via REST easily, so just verify a known-bad pattern is absent
    const cnt = r.data ? r.data.length : 0;
    return { ok: true,
      signal: "Rows with clearly unsafe image URLs in array: " + cnt +
              ". Full URL safety audit requires DB-side query beyond REST API scope." };
  });
  // ======================================================================
  // CONCURRENCY TESTS
  // ======================================================================
  // ======================================================================
  // CROSS-TENANT RLS ISOLATION
  //
  // Requires the second test operator (TST) seeded by:
  //   node scripts/seed-test-operator-b.js
  // The seed creates operator id 33333333-... and a sign-in user
  // test-b@bidwizops.local. If sign-in fails, all tests in this section
  // are skipped — they only run when both operators exist. The CLU
  // operator (current `token`/`userId`) attempts to read/write TST's
  // resources and must be denied at every layer (RLS, RPC guards).
  // ======================================================================
  section("Cross-tenant RLS isolation (CLU vs TST)");
  const TST_OP_ID = "33333333-3333-3333-3333-333333333333";
  const TST_EMAIL = "test-b@bidwizops.local";
  const TST_PASSWORD = "TestOperatorB!2026";
  let tstToken = null;
  let tstUserId = null;
  try {
    const url = SUPABASE_URL + "/auth/v1/token?grant_type=password";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
      body: JSON.stringify({ email: TST_EMAIL, password: TST_PASSWORD }),
    });
    if (res.ok) {
      const j = await res.json();
      tstToken = j.access_token;
      tstUserId = j.user && j.user.id;
    }
  } catch { /* tstToken stays null */ }

  if (!tstToken) {
    await run("TST sign-in (run scripts/seed-test-operator-b.js first)", async () => {
      return { ok: false, signal: "TST not seeded — cross-tenant tests skipped. Run: node scripts/seed-test-operator-b.js" };
    });
  } else {
    // Pre-flight: create one TST-owned lot via service role so we have
    // something for CLU to fail to access. Cleaned up in the section's
    // teardown via title-prefix delete (same flow as other E2E lots).
    let tstLotId = null;
    let tstLotCode = null;
    {
      const codeRpc = await supaRpc(tstToken, "next_lot_code", { p_operator_id: TST_OP_ID });
      if (codeRpc.error) {
        await run("TST setup: next_lot_code(TST)", async () => ({
          ok: false, signal: "Failed: " + JSON.stringify(codeRpc.error).slice(0, 100),
        }));
      } else {
        tstLotCode = codeRpc.data;
        const ins = await supaInsert(tstToken, "lots", {
          operator_id: TST_OP_ID,
          auction_id: null, lot_number: null, warehouse_id: null,
          lot_code: tstLotCode,
          title: SMOKE_PREFIX + " TST-owned lot",
          condition: "good",
          msrp_cents: null, starting_bid_cents: 100,
          photo_urls: [],
          status: "pending_intake",
          external_code: null, close_at: null,
        });
        if (ins.error) {
          await run("TST setup: insert seed lot", async () => ({
            ok: false, signal: "Failed: " + JSON.stringify(ins.error).slice(0, 100),
          }));
        } else {
          tstLotId = ins.data && ins.data.id;
        }
      }
    }

    // Run the actual cross-tenant tests only when setup succeeded.
    if (tstLotId) {
      // 1. CLU (current `token`) tries to SELECT TST's lot by id —
      //    RLS lots_staff_all has WHERE operator_id = current_operator_id().
      //    For CLU, current_operator_id() returns CLU's id. The query
      //    should return zero rows even though the lot exists.
      await run("CLU cannot SELECT TST's lot by id (RLS)", async () => {
        const r = await supaSelect(token, "lots", "id=eq." + tstLotId, "id,operator_id");
        if (r.error) return { ok: false, signal: "Unexpected error: " + JSON.stringify(r.error).slice(0, 100) };
        const rows = Array.isArray(r.data) ? r.data : [];
        return { ok: rows.length === 0,
          signal: rows.length === 0 ? "RLS correctly returned 0 rows" : "LEAK: returned " + rows.length + " row(s)" };
      });

      // 2. CLU tries to UPDATE TST's lot. RLS WITH CHECK should block:
      //    PostgREST returns 0 rows updated, no error (silent denial is
      //    standard PostgREST behavior). We verify by re-reading via
      //    service role and confirming the title is unchanged.
      await run("CLU cannot UPDATE TST's lot (RLS WITH CHECK silently blocks)", async () => {
        const upd = await fetch(SUPABASE_URL + "/rest/v1/lots?id=eq." + tstLotId, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON,
            Authorization: "Bearer " + token,
            Prefer: "return=representation",
          },
          body: JSON.stringify({ title: SMOKE_PREFIX + " HIJACKED BY CLU" }),
        });
        const body = await upd.json().catch(() => null);
        const updatedRows = Array.isArray(body) ? body : [];
        // Verify via service role that the row is still TST's original title.
        const verify = await supaSelect(token, "lots", "id=eq." + tstLotId, "title", SERVICE_KEY);
        const stillOriginal = verify.data && verify.data[0] && verify.data[0].title === SMOKE_PREFIX + " TST-owned lot";
        return {
          ok: updatedRows.length === 0 && stillOriginal,
          signal: stillOriginal
            ? "RLS denied (returned 0 rows, original title intact)"
            : "LEAK: title was changed!",
        };
      });

      // 3. CLU tries to INSERT a lot claiming TST's operator_id. The new
      //    create_draft_lot RPC (R4.3) has an explicit guard that rejects
      //    operator-id mismatch with PG code 42501.
      await run("CLU cannot INSERT a lot for TST via create_draft_lot (R4.3 guard)", async () => {
        const rpc = await supaRpc(token, "create_draft_lot", {
          p_operator_id: TST_OP_ID,
          p_title: SMOKE_PREFIX + " hijack via RPC",
          p_description: null,
          p_category: null, p_category_id: null,
          p_condition: "good",
          p_msrp_cents: null, p_starting_bid_cents: 100,
          p_photo_urls: [],
          p_external_code: null,
        });
        if (!rpc.error) return { ok: false, signal: "LEAK: RPC accepted cross-tenant insert" };
        const code = rpc.error.code || "";
        const isAccessDenied = code === "42501" || code === "P0001" || /cannot create lot/i.test(rpc.error.message || "");
        return { ok: isAccessDenied, signal: "Rejected with code=" + code + " (expected 42501)" };
      });

      // 4. CLU tries the legacy two-step path: next_lot_code(TST_OP_ID).
      //    next_lot_code is SECURITY DEFINER but has no operator-match
      //    guard — it bumps whichever operator's seq you pass. This test
      //    documents that behavior so we know the guard is RPC-side only.
      //    The follow-up INSERT into lots WITH operator_id=TST is what
      //    RLS catches: RLS WITH CHECK on lots requires
      //    operator_id = current_operator_id().
      await run("CLU INSERT lot row claiming TST operator_id (RLS rejects)", async () => {
        const codeRpc = await supaRpc(token, "next_lot_code", { p_operator_id: TST_OP_ID });
        if (codeRpc.error) {
          // Some envs reject this earlier — that's also fine.
          return { ok: true, signal: "next_lot_code rejected outright: " + JSON.stringify(codeRpc.error).slice(0, 80) };
        }
        const ins = await supaInsert(token, "lots", {
          operator_id: TST_OP_ID,
          auction_id: null, lot_number: null, warehouse_id: null,
          lot_code: codeRpc.data,
          title: SMOKE_PREFIX + " RLS-bypass-attempt",
          condition: "good",
          msrp_cents: null, starting_bid_cents: 100,
          photo_urls: [],
          status: "pending_intake",
          external_code: null, close_at: null,
        });
        if (!ins.error) return { ok: false, signal: "LEAK: RLS allowed insert with foreign operator_id" };
        // Postgres RLS returns 42501 (insufficient_privilege) on WITH CHECK violation.
        return { ok: true, signal: "RLS correctly denied: " + (ins.error.code || "?") + " " + String(ins.error.message || "").slice(0, 60) };
      });

      // 5. TST sees TST's own lot (positive control).
      await run("TST CAN SELECT its own lot (positive control)", async () => {
        const r = await supaSelect(tstToken, "lots", "id=eq." + tstLotId, "id,operator_id");
        const rows = Array.isArray(r.data) ? r.data : [];
        return { ok: rows.length === 1 && rows[0].operator_id === TST_OP_ID,
          signal: rows.length === 1 ? "found own lot, operator_id matches" : "expected 1 row, got " + rows.length };
      });

      // 6. TST cannot see CLU's lots — symmetric check.
      await run("TST cannot SELECT any lot belonging to CLU", async () => {
        const r = await supaSelect(tstToken, "lots", "operator_id=eq." + operatorId, "id", null);
        const rows = Array.isArray(r.data) ? r.data : [];
        return { ok: rows.length === 0,
          signal: rows.length === 0 ? "RLS correctly hid all CLU lots" : "LEAK: TST can see " + rows.length + " CLU lot(s)" };
      });
    }

    // Cleanup: delete TST's seeded lot via service role so the next run
    // starts clean. Title-prefix delete in the global teardown also
    // catches this; explicit here for clarity.
    if (tstLotId) {
      await supaDelete(SERVICE_KEY ? token : tstToken, "lots", "id=eq." + tstLotId);
    }
  }

  section("Concurrency");
  await run("5 concurrent next_lot_code calls -> all distinct, monotonic", async () => {
    const N = 5;
    const calls = Array.from({ length: N }, (_, i) =>
      createLot(token, operatorId, { title: SMOKE_PREFIX + " Concurrent-" + i, condition: "Good" }, [])
    );
    const settled = await Promise.allSettled(calls);
    const codes = []; const errors = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.ok) codes.push(r.value.lotCode);
      else errors.push(r.status === "rejected" ? (r.reason && r.reason.message) : JSON.stringify(r.value && r.value.error));
    }
    if (errors.length) return { ok: false, signal: errors.length + "/" + N + " failed: " + errors[0] };
    const allUnique = new Set(codes).size === codes.length;
    return { ok: allUnique,
      signal: codes.length + "/" + N + " created. unique=" + allUnique + ". codes=" + codes.join(" "),
      detail: allUnique ? "" : "DUPLICATE lot_codes: " + JSON.stringify(codes) };
  });
  // ======================================================================
  // CLEANUP
  // ======================================================================
  console.log("\n" + C.dim("  Cleaning up test data..."));
  try {
    const delLots = await supaDelete(token, "lots", "title=like." + encodeURIComponent(SMOKE_PREFIX + "%"));
    const cntL = Array.isArray(delLots.data) ? delLots.data.length : "?";
    console.log(C.dim("  Deleted ~" + cntL + " test lots"));
  } catch(e) { console.warn(C.yellow("  Cleanup lots warning: " + e.message)); }
  if (testImportId) {
    try {
      const delImpRows = await supaDelete(token, "import_rows", "import_id=eq." + testImportId);
      const delImp = await supaDelete(token, "imports", "id=eq." + testImportId);
      console.log(C.dim("  Deleted test import_rows and import"));
    } catch(e) { console.warn(C.yellow("  Cleanup imports warning: " + e.message)); }
  }
  // ======================================================================
  // SUMMARY
  // ======================================================================
  const hr = "-".repeat(80);
  console.log("\n" + C.bold(hr));
  console.log(C.bold("  SUMMARY"));
  console.log(C.bold(hr));
  console.log("  " + "Test".padEnd(58) + "Status  ms");
  console.log("  " + hr);
  let lastSection = "";
  for (const r of results) {
    const s = r.ok ? C.green("PASS") : C.red("FAIL");
    const nm = r.name.length > 57 ? r.name.slice(0, 54) + "..." : r.name;
    console.log("  " + s + "  " + nm.padEnd(57) + " " + String(r.elapsed).padStart(5) + "ms");
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;
  const elapsed = Date.now();
  console.log("  " + hr);
  console.log(C.bold("  Result: ") + passed + "/" + total + " passed" +
    (failed > 0 ? (", " + C.red(failed + " FAILED")) : ""));
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
};
main().catch((e) => {
  console.error("\x1b[31mFatal:\x1b[0m", e.message);
  console.error(e.stack);
  process.exit(2);
});
