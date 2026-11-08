// parseReportRange — the server-side half of the shared ?from=&to= report
// filter (components/ReportDateRange). Every report tab funnels its period
// through this, so a bad parse silently changes what a money figure means.
//
// The load-bearing case is the INVERTED range: from > to would produce an empty
// window, and an empty window renders as $0 / "no data" — indistinguishable from
// a real zero. We collapse it to all-time instead, so a fat-fingered date shows
// too much rather than a convincing lie.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReportRange } from '@/lib/report-range';

describe('parseReportRange', () => {
  it('passes through a valid range', () => {
    expect(parseReportRange({ from: '2026-07-01', to: '2026-07-31' })).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('treats a missing range as all-time', () => {
    expect(parseReportRange({})).toEqual({ from: null, to: null });
  });

  it('rejects an inverted range rather than yielding an empty window', () => {
    // Would otherwise render as a confident $0.
    expect(parseReportRange({ from: '2026-07-31', to: '2026-07-01' })).toEqual({
      from: null,
      to: null,
    });
  });

  it('allows a single-day range (from === to)', () => {
    expect(parseReportRange({ from: '2026-07-15', to: '2026-07-15' })).toEqual({
      from: '2026-07-15',
      to: '2026-07-15',
    });
  });

  it('drops malformed dates instead of passing them to SQL', () => {
    expect(parseReportRange({ from: 'yesterday', to: '2026-07-31' })).toEqual({
      from: null,
      to: '2026-07-31',
    });
    expect(parseReportRange({ from: '2026-7-1', to: '2026-07-31' })).toEqual({
      from: null,
      to: '2026-07-31',
    });
    expect(parseReportRange({ from: "2026-07-01'; DROP TABLE lots--", to: undefined })).toEqual({
      from: null,
      to: null,
    });
  });

  it('keeps one bound when only one is supplied', () => {
    // Half-open is meaningful: "everything since X".
    expect(parseReportRange({ from: '2026-07-01' })).toEqual({ from: '2026-07-01', to: null });
    expect(parseReportRange({ to: '2026-07-31' })).toEqual({ from: null, to: '2026-07-31' });
  });
});

describe('client/server boundary', () => {
  // Regression guard for 2026-07-27: parseReportRange originally lived in
  // components/ReportDateRange.tsx, which is a 'use client' module. Every export
  // of a client module becomes a client reference proxy when a Server Component
  // imports it, so the three report pages threw at render the moment they called
  // it — /reports/money, /reports/bidders and /reports/auctions were all down.
  //
  // Nothing caught it: tsc resolves the import fine, and the pages are
  // force-dynamic so the build never prerenders them. This test is the check
  // that would have.
  const root = join(__dirname, '..', '..');

  it('keeps the parser out of the client module', () => {
    const client = readFileSync(join(root, 'components', 'ReportDateRange.tsx'), 'utf8');
    expect(client.startsWith("'use client'")).toBe(true);
    expect(client).not.toMatch(/export\s+function\s+parseReportRange/);
  });

  it('has every report page import the parser from lib, not the client module', () => {
    for (const page of ['money', 'bidders', 'auctions']) {
      const src = readFileSync(join(root, 'app', '(operator)', 'reports', page, 'page.tsx'), 'utf8');
      // The page may still import the ReportDateRange COMPONENT from the client
      // module — that is fine and expected. What must never happen is pulling a
      // callable out of it.
      expect(src, `${page}/page.tsx`).not.toMatch(
        /import\s*\{[^}]*parseReportRange[^}]*\}\s*from\s*'@\/components\/ReportDateRange'/,
      );
      expect(src, `${page}/page.tsx`).toMatch(/from '@\/lib\/report-range'/);
    }
  });
});
