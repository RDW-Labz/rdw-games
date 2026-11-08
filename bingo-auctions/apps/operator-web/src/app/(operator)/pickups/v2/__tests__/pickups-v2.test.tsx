import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { renderToString } from 'react-dom/server';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { statusPresentation } from '@/components/console-v2/status';
import { PickupsV2 } from '../PickupsV2';
import { pickupsV2Fixture, pickupsV2FixtureNoMissing } from '../__fixtures__/pickups-fixture';

describe('PickupsV2', () => {
  it('orders counter before missing items and shows amber strip linking to #missing-items', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    expect(html.indexOf('id="pickups-v2-counter"')).toBeLessThan(html.indexOf('id="missing-items"'));
    expect(html).toContain('console-v2-pickups-missing-alert');
    const compact = html.replace(/<!-- -->/g, '');
    expect(compact).toContain(`${formatCount(2)} missing items awaiting refund`);
  });

  it('hides amber strip when there are no missing items', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2FixtureNoMissing} />);
    expect(html).not.toContain('missing-items awaiting refund');
    expect(html).not.toContain('href="#missing-items"');
  });

  it('shows pay-invoice guard on unpaid waiting row', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    // Unpaid rows keep v1's real next step; no placeholder web Check in button.
    expect(html).toContain('Mark paid (offline) first');
    expect(html).not.toMatch(/>Check in<\/button>/);
    expect(html).toContain('Sample Unpaid Waiting');
  });

  it('uses status pill tokens by meaning', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    const paid = statusPresentation('paid');
    const checkedIn = statusPresentation('checked_in');
    const unpaid = statusPresentation('unpaid');
    expect(html).toContain(paid.background);
    expect(html).toContain(checkedIn.background);
    expect(html).toContain(unpaid.background);
  });

  it('uses off-white ink for stage-less section titles and pickup hue for staged queues', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    expect(html).toContain('var(--console-stage-pickup-text)');
    const missingIdx = html.indexOf('id="missing-items"');
    expect(html.slice(missingIdx, missingIdx + 500)).toMatch(/var\(--console-ink\)/);
    const doneIdx = html.indexOf('id="pickups-v2-done"');
    expect(html.slice(doneIdx, doneIdx + 500)).toMatch(/var\(--console-ink\)/);
  });

  it('formats section counts with thousands separators', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    expect(html).toContain('At the counter (24)');
    expect(formatCount(1240)).toBe('1,240');
    expect(html).toContain(`Waiting (${formatCount(40)})`);
  });

  it('staggers queue rows with motion class', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    const rows = html.match(/console-v2-motion-row-in/g) ?? [];
    expect(rows.length).toBe(24 + 18 + 40 + 10);
  });

  it('header search shows one label, Find customer', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    expect(html).toContain('>Find customer</h2>');
    expect(html).not.toContain('Customer search');
  });

  it('rail: every stage hued, Pickup current with its glow class', () => {
    const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />);
    const cards = [...html.matchAll(/<article class="([^"]*console-v2-stage-card[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.includes('console-v2-stage-hued'))).toBe(true);
    expect(cards.filter((c) => c.includes('--current'))).toEqual([
      // + motion: reveals last of the rail and pulses once in its stage hue.
      'console-v2-stage-card console-v2-stage-hued console-v2-stage-hue--pickup console-v2-stage-card--current console-v2-motion-reveal console-v2-motion-pulse-once',
    ]);
  });
});
