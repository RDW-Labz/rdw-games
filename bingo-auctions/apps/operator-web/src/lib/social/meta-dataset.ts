// The Meta dataset (formerly "Pixel") id for BinGo Auctions.
//
// ── WHY THIS IS A LITERAL AND NOT A SECRET ───────────────────────────────────
// A dataset id is public by construction. The browser Pixel embeds it in the
// page source that every visitor downloads, and Meta prints it in the install
// snippet they mail out. Treating it as a secret buys nothing and costs a
// manual setup step that has to be performed identically in two places.
//
// Two places, because the value is needed at BUILD time (NEXT_PUBLIC_* is
// inlined into the client bundle) and again at RUNTIME (the Conversions API
// drain reads it on the Worker). As two separate secrets they can drift, and
// the failure that drift produces is nasty: the browser reports into one
// dataset and the server into another, so neither has the full picture and
// event_id deduplication silently stops working. There is no error and no
// alert; the numbers are just quietly wrong. One constant makes that
// impossible.
//
// The env vars still override, so a fork, a staging build, or a future dataset
// change needs no code edit. Only the TOKEN is a real secret, and that one
// stays in META_CAPI_TOKEN / META_PAGE_ACCESS_TOKEN where it belongs.

export const META_DATASET_ID = '2325596888269013';

/** Build-time id for the browser Pixel.
 *
 * The server-side counterpart deliberately lives in meta-capi.ts rather than
 * here: this module is imported by a client component, and a `process.env.X`
 * read for a non-NEXT_PUBLIC name would be bundled into the browser as dead
 * code that can only ever evaluate to undefined. */
export function browserPixelId(): string {
  return process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim() || META_DATASET_ID;
}

