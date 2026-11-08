// Safety for user input that gets concatenated into a PostgREST filter string.
//
// ── The bug this exists for ─────────────────────────────────────────────────
// supabase-js `.or('col.op.val,...')` takes FILTER SYNTAX, not a bound
// parameter. PostgREST parses `,` `(` `)` `|` as the structure of a logical
// group. So any raw user text placed inside a `.or(...)` pattern can add terms
// of the caller's choosing to that group.
//
// On /api/search/suggest and /browse the search box built
// `.or('title.ilike.%<q>%,lot_code.ilike.%<q>%,sticker_code.ilike.%<q>%')`
// with `<q>` straight off the URL. Both endpoints are PUBLIC, UNAUTHENTICATED,
// and run under the service-role key. A request of the form
//
//     ?q=nomatch,title.ilike.
//
// makes one of the resulting OR terms `title.ilike.%` — always true — so the
// search returns rows the term never matched. Proven on prod 2026-09-20.
//
// The blast radius is bounded, and the bound is worth stating so this is not
// over- or under-fixed: the injection only widens ONE or-group. The table
// (`lots`), the selected columns, and the sibling AND filters (active auction,
// not deleted, sellable status) are all outside it and hold. So a caller
// cannot read other tables, other operators' rows, or columns outside the
// select. What they CAN do is filter the public lot set by an arbitrary
// predicate on ANY column — including columns not in the output — which turns
// the endpoint into a blind boolean oracle over hidden column values
// (winner_bidder_id, internal ids, bid internals) of public lots.
//
// ── The fix ─────────────────────────────────────────────────────────────────
// Strip the four structural metacharacters before the value goes anywhere near
// a filter string. Nothing downstream escapes them for us — `.or()` is a raw
// filter string by contract.
//
// Dots are preserved on purpose: they are ordinary in product names ("v1.2")
// and, inside an already-anchored `col.op.` term, a dot in the VALUE position
// is just data.
//
// This is the SECURITY-critical primitive. Callers that place user input into
// `.or(...)`, `.filter(...)`, or any other raw PostgREST filter MUST run it
// through here first. It is deliberately its own small module, with no other
// dependencies, so it is obvious and hard to accidentally drop.

export function sanitizePostgrestPattern(raw: string): string {
  return raw.replace(/[,()|]/g, ' ');
}
