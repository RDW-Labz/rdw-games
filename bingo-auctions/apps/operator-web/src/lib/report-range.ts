// Server-side half of the shared ?from=&to= report filter.
//
// This lives in lib/, NOT in components/ReportDateRange.tsx, and that
// separation is load-bearing rather than tidiness.
//
// ReportDateRange.tsx is a `'use client'` module. In the App Router every
// export of a client module becomes a CLIENT REFERENCE PROXY when a server
// component imports it — the function body never crosses the boundary. So a
// server component doing:
//
//     import { parseReportRange } from '@/components/ReportDateRange';
//     const { from, to } = parseReportRange(sp);   // <- throws at render
//
// blows up at runtime with "Attempted to call parseReportRange() from the
// server but parseReportRange is on the client". That is exactly what took out
// /reports/money, /reports/bidders and /reports/auctions (reported 2026-07-27).
// It type-checks cleanly and builds cleanly — the three pages are
// force-dynamic, so nothing prerenders them — which is why CI stayed green.
//
// Keeping the parser in a module with no 'use client' means both sides can
// import it: the client control for its own validation, the server pages for
// the real parse.

/**
 * Parse the shared contract. Returns validated YYYY-MM-DD strings, or nulls
 * when absent/malformed — callers treat null as "all time".
 *
 * Rejects an inverted range (from > to) rather than returning an empty window,
 * because an empty window renders as a confident $0 that is indistinguishable
 * from a real zero. Showing too much beats a convincing lie.
 */
export function parseReportRange(sp: { from?: string; to?: string }): {
  from: string | null;
  to: string | null;
} {
  const ok = (v: string | undefined): string | null =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const from = ok(sp.from);
  const to = ok(sp.to);
  if (from && to && from > to) return { from: null, to: null };
  return { from, to };
}
