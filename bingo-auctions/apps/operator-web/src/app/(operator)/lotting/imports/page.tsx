// /lotting/imports — redirects to the existing /imports tree. The
// IA reorg presents Imports under the "Lotting" sidebar group, but
// the actual page tree (with [id] detail + new) lives at /imports
// for now. Consolidating into /lotting/imports/[id]/* later is
// a backlog item — this redirect keeps the URL story consistent.

import { redirect } from 'next/navigation';

export default async function LottingImportsRedirect(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === 'string') qs.set(k, v[0]);
  }
  const tail = qs.toString() ? `?${qs.toString()}` : '';
  redirect(`/imports${tail}`);
}
