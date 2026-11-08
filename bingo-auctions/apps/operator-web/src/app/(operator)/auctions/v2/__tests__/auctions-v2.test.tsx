import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { renderToString } from 'react-dom/server';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { CloneAuctionButton } from '../../CloneAuctionButton';
import { AuctionsV2 } from '../AuctionsV2';
import { capitaliseStatusLabel } from '../AuctionStatusPill';
import { lastCloseParts, splitDateLabel } from '../auction-date-label';
import { auctionsListV2Fixture } from '../__fixtures__/auctions-list-fixture';

const html = renderToString(<AuctionsV2 {...auctionsListV2Fixture} />);
const text = (s: string) => s.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

function rowHtml(id: string): string {
  const rows = html.split('<tr ').slice(1);
  const hit = rows.find((r) => r.includes(`/auctions/${id}"`));
  if (!hit) throw new Error(`row ${id} not found`);
  return hit;
}

describe('AuctionsV2 — v1 table structure, v2 skin', () => {
  it('is a real table with the v1 columns in v1 order', () => {
    expect(html).toContain('<table');
    const headers = [...html.matchAll(/<th scope="col" data-col="([a-z]+)"/g)].map((m) => m[1]);
    expect(headers).toEqual(['thumbs', 'title', 'status', 'starts', 'ends', 'premium', 'clone']);
    const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(text(thead)).toBe('PhotosTitleStatusStartsEndsPremiumClone');
  });

  it('gives the thumbs column a fixed 120px <col> (CSS token), so titles cannot run under it', () => {
    expect(html).toMatch(/<colgroup><col class="console-v2-list-col-thumbs"\/>/);
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/--console-list-thumbs-width:\s*120px;/);
    expect(css).toMatch(/\.console-v2-list-col-thumbs \{\s*width: var\(--console-list-thumbs-width\);/);
    expect(css).toMatch(/\.console-v2-list-table \{[^}]*table-layout: fixed;/);
  });

  it('shows up to three featured images with alt text, and nothing for an auction with none', () => {
    const live = rowHtml('a-live-1');
    expect(live.match(/<img /g)?.length).toBe(3);
    expect(live).toContain('alt="Tuesday Evening General, featured photo 1"');
    expect(live).toContain('src="/art/categories/furniture.webp"');
    const draft = rowHtml('a-draft-1');
    expect(draft).not.toContain('<img');
    expect(draft).toMatch(/<td data-col="thumbs"><\/td>/);
    expect(rowHtml('a-offsite-1').match(/<img /g)?.length).toBe(2);
  });

  it('puts warehouse · lot count · Off-site under the title in a small meta line', () => {
    const offsite = rowHtml('a-offsite-1');
    const meta = offsite.slice(offsite.indexOf('console-v2-list-meta'));
    expect(text(meta.slice(0, meta.indexOf('</div>')))).toContain(
      `Temporary — Crandall TX·${formatCount(3500)} lotsOff-site`,
    );
    expect(offsite).toContain('console-v2-list-offsite');
    expect(rowHtml('a-live-1')).not.toContain('Off-site');
    expect(text(html)).toContain(`${formatCount(128)} lots`);
  });

  it('adds Last close as a second line under Ends (time only when same day)', () => {
    const live = rowHtml('a-live-1');
    expect(text(live)).toContain('Oct 7, 2025, 8:00 PM CDTLast close 10:30 PM CDT');
    expect(text(rowHtml('a-closed-1'))).toContain('Last close Oct 6, 2025, 12:15 AM CDT');
  });

  it('keeps the v1 Premium value', () => {
    expect(text(rowHtml('a-live-1'))).toContain('15.0%');
    expect(text(rowHtml('a-closed-1'))).toContain('12.5%');
  });

  it('status pills: Scheduled teal, Live lime with dot, Draft grey, capitalised; others meaning-mapped', () => {
    expect(rowHtml('a-offsite-1')).toMatch(/console-v2-list-pill console-v2-list-pill--scheduled[^>]*>Scheduled</);
    const live = rowHtml('a-live-1');
    expect(live).toMatch(/console-v2-list-pill--live[^>]*><span class="console-v2-list-pill__dot" aria-hidden="true"><\/span>Live</);
    expect(rowHtml('a-draft-1')).toMatch(/console-v2-list-pill--draft[^>]*>Draft</);
    expect(rowHtml('a-draft-1')).not.toContain('console-v2-list-pill__dot');
    const closed = rowHtml('a-closed-1');
    expect(closed).toContain('console-v2-status-pill');
    expect(text(closed)).toContain('Closed');
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/--console-list-pill-scheduled-bg: var\(--console-stage-intake-bg\)/);
    expect(css).toMatch(/--console-list-pill-live-dot: var\(--console-action\)/);
    expect(css).toMatch(/--console-list-pill-draft-bg: var\(--console-neutral-bg\)/);
  });

  it('Clone is still the v1 CloneAuctionButton, one per row', () => {
    const v1 = renderToString(<CloneAuctionButton auctionId="a-live-1" />);
    expect(rowHtml('a-live-1')).toContain(v1);
    expect(html.match(/Duplicate this auction&#x27;s settings into a new draft/g)?.length).toBe(
      auctionsListV2Fixture.rows.length,
    );
  });

  it('drops the "Your auctions / Same order and limit…" dev note', () => {
    expect(html).not.toContain('Your auctions');
    expect(html).not.toContain('Same order and limit');
  });

  it('staggers rows with the motion class', () => {
    expect(html.match(/console-v2-motion-row-in/g)?.length).toBe(auctionsListV2Fixture.rows.length);
  });
});

describe('auction list date labels', () => {
  it('splits formatInTimeZone output at the year, keeping v1 comma', () => {
    expect(splitDateLabel('Oct 7, 2025, 8:00 PM CDT')).toEqual({ date: 'Oct 7, 2025,', time: '8:00 PM CDT' });
    expect(splitDateLabel('—')).toEqual({ date: '—', time: '' });
  });

  it('drops the date from Last close only on the same day', () => {
    expect(lastCloseParts('Oct 7, 2025, 8:00 PM CDT', 'Oct 7, 2025, 10:30 PM CDT')).toEqual({
      date: '',
      time: '10:30 PM CDT',
    });
    expect(lastCloseParts('Oct 5, 2025, 8:00 PM CDT', 'Oct 6, 2025, 12:15 AM CDT')).toEqual({
      date: 'Oct 6, 2025,',
      time: '12:15 AM CDT',
    });
  });

  it('capitalises fallback status labels', () => {
    expect(capitaliseStatusLabel('closed')).toBe('Closed');
    expect(capitaliseStatusLabel('canceled')).toBe('Canceled');
    expect(capitaliseStatusLabel('')).toBe('Unknown');
  });
});
