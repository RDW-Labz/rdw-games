// /lots — was a global "every lot in any state" listing. The IA
// reorg deprecates that role: operator workflows now go through
// /lotting/inventory (in_inventory), /lotting/drafts (pending_intake),
// /lotting/manifest-pool (pending import_rows), or the auction-
// specific lot tables.
//
// Per-lot detail/edit pages at /lots/[id] are unchanged and still
// referenced from auctions, so we keep this directory tree alive
// for those — only the index redirects.

import { redirect } from 'next/navigation';

export default function LotsIndexRedirect() {
  redirect('/lotting/inventory');
}
