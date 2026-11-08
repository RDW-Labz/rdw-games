import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LotDetailV2 } from '../LotDetailV2';
import { lotDetailFixtures } from '../__fixtures__/lot-detail-fixture';

describe('LotDetailV2', () => {
  it('shows sticker before BIN and no-sticker flag', () => {
    const html = renderToString(<LotDetailV2 {...lotDetailFixtures.unsoldInventory} />);
    expect(html.indexOf('BRN4982227')).toBeLessThan(html.indexOf('BIN-031200'));
    const noStickerHtml = renderToString(<LotDetailV2 {...lotDetailFixtures.noSticker} />);
    expect(noStickerHtml).toContain('No sticker');
  });

  it('places Choose the next step before What is on record', () => {
    const html = renderToString(<LotDetailV2 {...lotDetailFixtures.unsoldInventory} />);
    expect(html.indexOf('Choose the next step')).toBeLessThan(html.indexOf('What is on record'));
  });

  it('includes remove action for inventory lot', () => {
    const html = renderToString(<LotDetailV2 {...lotDetailFixtures.unsoldInventory} />);
    expect(html).toContain('Remove from inventory control');
  });

  it('formats money with commas', () => {
    const html = renderToString(<LotDetailV2 {...lotDetailFixtures.soldWithBids} />);
    expect(html).toContain('$64.00');
  });

  it('rail hues every stage and marks the lot\'s own stage current', () => {
    const cards = (html: string) =>
      [...html.matchAll(/<article class="([^"]*console-v2-stage-card[^"]*)"/g)].map((m) => m[1] ?? '');
    const sold = cards(renderToString(<LotDetailV2 {...lotDetailFixtures.soldWithBids} />));
    expect(sold).toHaveLength(5);
    for (const stage of ['intake', 'lotting', 'auction', 'paid', 'pickup']) {
      expect(sold.some((c) => c.includes(`console-v2-stage-hue--${stage}`))).toBe(true);
    }
    // Won + paid invoice → Paid is current, nothing else.
    expect(sold.filter((c) => c.includes('--current'))).toEqual([
      // + motion: reveal index 4, then pulses once in its stage hue.
      'console-v2-stage-card console-v2-stage-hued console-v2-stage-hue--paid console-v2-stage-card--current console-v2-motion-reveal console-v2-motion-pulse-once',
    ]);
    const inv = cards(renderToString(<LotDetailV2 {...lotDetailFixtures.unsoldInventory} />));
    expect(inv.filter((c) => c.includes('--current'))[0]).toContain('console-v2-stage-hue--lotting');
  });

  it('timeline title is stage-less (off-white)', () => {
    const html = renderToString(<LotDetailV2 {...lotDetailFixtures.soldWithBids} />);
    const at = html.indexOf('id="lot-v2-timeline"');
    expect(html.slice(at, at + 400)).toContain('color:var(--console-ink)');
  });
});
