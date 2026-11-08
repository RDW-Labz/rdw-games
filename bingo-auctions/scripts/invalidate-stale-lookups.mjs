// Invalidate product_lookups rows that don't have MSRP captured.
//
// Use this after a prompt/parser change to force re-scans for the
// affected lots. The product_lookups cache has a long TTL (~7 days)
// so stale rows from before a fix keep getting served until the row
// is deleted or its updated_at ages out.
//
// Default behaviour (no flags): print a report only — show which rows
// would be invalidated and let the operator audit before destruction.
// Pass `--apply` to actually delete the rows. `--dry-run` is the
// default and explicit.
//
// Usage (SUPABASE_URL is required — there is no default project; BinGo prod
// is https://npwseclcxcatjhgjrtwe.supabase.co):
//   SUPABASE_URL=... SERVICE_KEY=... node scripts/invalidate-stale-lookups.mjs            # dry-run report
//   SUPABASE_URL=... SERVICE_KEY=... node scripts/invalidate-stale-lookups.mjs --apply    # actually delete
//   SUPABASE_URL=... SERVICE_KEY=... node scripts/invalidate-stale-lookups.mjs --since 2026-05-13T00:00:00Z --apply
//
// Selection criteria (any row matching ALL):
//   - msrp_cents IS NULL
//   - confidence != 'none'  (negative-cache rows are kept; they have meaning)
//   - updated_at < --since  (defaults to 'now')
//   - prices array has ≥1 entry  (Sonar actually ran and fetched URLs).
//     Without this guard we'd churn ~500 catalog-import rows where Sonar
//     never ran (typically 'Pallet of General Merchandise' bulk imports
//     with prices=[]). Re-running Sonar on those would just produce the
//     same null result. We only want rows where the new parser/prompt
//     change has a real chance of recovering MSRP.

// The URL was hardcoded to the upstream project (this repo's upstream) with no
// override at all, so --apply deleted cache rows from another company's
// database. This script deletes; it does not guess.
const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SB_KEY = process.env.SERVICE_KEY ?? '';
if (!SB_KEY) {
  console.error('Set SERVICE_KEY env var to the service-role key from .env.smoke.local.');
  process.exit(1);
}
if (!SB_URL) {
  console.error(
    '[invalidate-stale-lookups] SUPABASE_URL is not set.\n\n' +
      '  There is no default Supabase project. Set the URL the SERVICE_KEY\n' +
      '  belongs to:\n\n' +
      '    SUPABASE_URL=https://npwseclcxcatjhgjrtwe.supabase.co SERVICE_KEY=... \\\n' +
      '      node scripts/invalidate-stale-lookups.mjs\n\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm before --apply.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx !== -1 ? args[sinceIdx + 1] : new Date().toISOString();

const headers = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

// Find stale rows via PostgREST. msrp_cents=is.null + updated_at<lt.<since>
// + confidence=not.eq.none (preserve negative-cache rows).
const qs = new URLSearchParams({
  select: 'upc,title,brand,msrp_cents,confidence,updated_at,prices',
  msrp_cents: 'is.null',
  updated_at: `lt.${since}`,
  confidence: 'neq.none',
  order: 'updated_at.desc',
  limit: '5000',
});

const listUrl = `${SB_URL}/rest/v1/product_lookups?${qs.toString()}`;
const listRes = await fetch(listUrl, { headers });
if (!listRes.ok) {
  console.error('list failed:', listRes.status, await listRes.text());
  process.exit(1);
}
const allRows = await listRes.json();
// Filter to rows where Sonar actually fetched retailer URLs. PostgREST
// can't easily filter on JSONB array length, so we filter client-side.
const rows = allRows.filter((r) => Array.isArray(r.prices) && r.prices.length >= 1);

console.log(`\n=== Stale lookups (msrp_cents IS NULL, updated_at < ${since}) ===`);
console.log(`Found: ${rows.length} rows`);
console.log();

if (rows.length === 0) {
  console.log('Nothing to invalidate. Cache is clean.');
  process.exit(0);
}

// Per-row preview
for (const r of rows.slice(0, 20)) {
  const priceCount = Array.isArray(r.prices) ? r.prices.length : 0;
  const amazonOnly = priceCount > 0 && r.prices.every((p) => /amazon\./i.test(p.url ?? ''));
  const tag = amazonOnly ? ' [Amazon-only]' : '';
  console.log(
    `  ${r.upc.padEnd(20)} ${r.confidence.padEnd(8)} prices=${priceCount} updated=${r.updated_at.slice(0, 19)}${tag}`,
  );
  console.log(`    ${(r.title ?? '').slice(0, 80)}`);
}
if (rows.length > 20) {
  console.log(`  ... and ${rows.length - 20} more`);
}
console.log();

if (!apply) {
  console.log('DRY RUN — no rows deleted. Re-run with --apply to actually invalidate.');
  process.exit(0);
}

// Delete. PostgREST DELETE with the same filter.
console.log(`Deleting ${rows.length} rows…`);
const upcsParam = rows.map((r) => r.upc);
// PostgREST supports `in.(...)` — batch delete by upc list.
const delQs = new URLSearchParams({
  upc: `in.(${upcsParam.map(encodeURIComponent).join(',')})`,
});
const delRes = await fetch(`${SB_URL}/rest/v1/product_lookups?${delQs.toString()}`, {
  method: 'DELETE',
  headers,
});
if (!delRes.ok) {
  console.error('delete failed:', delRes.status, await delRes.text());
  process.exit(1);
}
console.log(`Deleted ${rows.length} stale rows. Next scan of these UPCs will re-run Sonar.`);
