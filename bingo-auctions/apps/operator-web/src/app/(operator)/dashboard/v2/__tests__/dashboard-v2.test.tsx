import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DashboardV2 } from '../DashboardV2';
import { dashboardV2Fixture } from '../__fixtures__/dashboard-fixture';

describe('DashboardV2', () => {
  it('renders floor story, stats, and closing table from fixture', () => {
    const html = renderToString(<DashboardV2 {...dashboardV2Fixture} />);

    expect(html).toContain('Needs attention');
    expect(html.indexOf('Pickup')).toBeLessThan(html.indexOf('Auction'));
    expect(html).toContain('24 at the counter');
    expect(html).toContain('344 with no sticker');
    expect(html).toContain('171 closing within 2 h');
    expect(html).toContain('Check out 24');
    expect((html.match(/console-v2-btn--primary-lime/g) ?? []).length).toBe(1);

    const rowMatches = html.match(/console-v2-motion-row-in/g) ?? [];
    expect(rowMatches.length).toBe(8);

    for (const stat of dashboardV2Fixture.stats) {
      expect(stat.label).not.toContain(stat.value);
    }

    expect(html).toContain('$12,840');
    expect(html).toContain('$11,860');
    expect(html).toContain('$642');
    expect(html).toContain('BRN4982227');
    expect(html).toContain('No sticker');
  });

  it('Needs attention: every card carries its stage hue; the urgent card is current', () => {
    const html = renderToString(<DashboardV2 {...dashboardV2Fixture} />);
    const cards = [...html.matchAll(/<article class="([^"]*console-v2-stage-card[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.includes('console-v2-stage-hued'))).toBe(true);
    expect(cards[0]).toContain('console-v2-stage-hue--pickup');
    expect(cards[0]).toContain('console-v2-stage-card--current');
    expect(cards.slice(1).some((c) => c.includes('--current'))).toBe(false);
    expect(html).not.toMatch(/border-left-color/);
  });

  describe('three refs (2026-10-13)', () => {
    const html = renderToString(<DashboardV2 {...dashboardV2Fixture} />);

    it('opts the page root into the refs page (lime focus) and the 3% grid texture', () => {
      const root = /<div data-console-v2="[^"]*" class="([^"]*)"/.exec(html)?.[1] ?? '';
      expect(root).toContain('console-v2-refs-page');
      expect(root).toContain('console-v2-texture-grid');
      // The texture replaces the inline frame background.
      expect(html).not.toMatch(/background:var\(--console-gradient-frame\)/);
    });

    it('page header carries ONE primary action top-right: a real link to lot lookup', () => {
      const head = html.slice(html.indexOf('console-v2-page-head'), html.indexOf('console-v2-dashboard-stats'));
      const buttons = head.match(/console-v2-btn[ "]/g) ?? [];
      expect(buttons).toHaveLength(1);
      const link = /<a [^>]*>Look up a lot<\/a>/.exec(head)?.[0] ?? '';
      expect(link).toContain('href="/lots/lookup"');
      expect(link).toContain('console-v2-btn--solid');
      // Lime stays the single floor action (urgent card).
      expect((html.match(/console-v2-btn--primary-lime/g) ?? []).length).toBe(1);
    });

    it('live chip shows the real at-the-counter count from the Pickup stage', () => {
      expect(html).toContain('console-v2-live-chip');
      expect(html.replace(/<!-- -->/g, '')).toContain('· 24 at the counter');
    });

    it('no live chip without a counter count; no trend pills anywhere (no trend data)', () => {
      const stages = dashboardV2Fixture.stages.map((s) => (s.id === 'pickup' ? { ...s, count: null, primaryAction: null } : s));
      const noCount = renderToString(<DashboardV2 {...dashboardV2Fixture} stages={stages} />);
      expect(noCount).not.toContain('console-v2-live-chip');
      expect(html).not.toContain('console-v2-trend-pill');
    });

    it('corner brackets sit on the urgent stage card only, and only when it has work', () => {
      expect((html.match(/console-v2-frame-bracket/g) ?? []).length).toBe(1);
      const first = /<article class="([^"]*console-v2-stage-card[^"]*)"/.exec(html)?.[1] ?? '';
      expect(first).toContain('console-v2-frame-bracket');
      expect(first).toContain('console-v2-stage-hue--pickup');

      const idle = dashboardV2Fixture.stages.map((s) => ({ ...s, count: null, primaryAction: null }));
      const quiet = renderToString(<DashboardV2 {...dashboardV2Fixture} stages={idle} />);
      expect(quiet).not.toContain('console-v2-frame-bracket');
    });

    it('floor story has one decorative scan-line, hidden from assistive tech', () => {
      const scan = html.match(/<span class="console-v2-scanline"[^>]*>/g) ?? [];
      expect(scan).toEqual(['<span class="console-v2-scanline" aria-hidden="true">']);
      const rail = html.slice(html.indexOf('aria-label="Needs attention"'));
      expect(rail.indexOf('console-v2-scanline')).toBeLessThan(rail.indexOf('Needs attention</h2>'));
    });

    it('mono-style labels over values: stat, finance and stage-number labels', () => {
      const labels = html.match(/console-v2-stat-tile__label console-v2-label-mono/g) ?? [];
      expect(labels).toHaveLength(dashboardV2Fixture.stats.length + 3);
      expect((html.match(/console-v2-stage-card__num console-v2-label-mono/g) ?? []).length).toBe(5);
      // No sci-fi copy.
      expect(html).not.toMatch(/SYS_|NEURAL|_[A-Z]{2,}/);
    });

    it('keeps every existing link on the dashboard', () => {
      for (const href of [
        '/pickups',
        '/lotting/drafts',
        '#next-to-close',
        '/loads',
        '/lotting/inventory',
        '/auctions',
        '/disputes',
        '/bidders?filter=resale_pending',
        '/invoices?status=unpaid',
        '/reports/money',
        '/invoices',
        '/lots/sample-1',
      ]) {
        expect(html, href).toContain(`href="${href}"`);
      }
    });
  });
});
