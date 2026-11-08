// /inventory was renamed to /lotting/inventory in the IA reorg.
// Bookmarks + external links to /inventory still resolve via this
// redirect stub. The actual page logic now lives at
// app/(operator)/lotting/inventory/page.tsx.
//
// The query string (status filter) is preserved on the redirect so a
// link to /inventory?status=in_inventory still lands on the right tab.

import { redirect } from 'next/navigation';

export default async function InventoryRedirect(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === 'string') qs.set(k, v[0]);
  }
  const tail = qs.toString() ? `?${qs.toString()}` : '';
  redirect(`/lotting/inventory${tail}`);
}
