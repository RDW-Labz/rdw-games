import { describe, it, expect, vi } from 'vitest';

// lib/img-proxy reads NEXT_PUBLIC_SUPABASE_URL into a module-level const, so
// it has to be set BEFORE the import graph is evaluated — hence vi.hoisted
// rather than a plain assignment (ESM hoists imports above statements). In
// the Worker this is always populated; without it cdnImageUrl no-ops and the
// self-hosted-vs-hotlink distinction collapses.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://npwseclcxcatjhgjrtwe.supabase.co';
});

import {
  toFeedRow,
  toCsv,
  csvEscape,
  metaCondition,
  formatPrice,
  clampText,
  FEED_AUCTION_STATUSES,
  FEED_CLOSING_SOON_MINUTES,
  orderPhotosForAds,
  bidActivityLabel,
  FEED_COLUMNS,
  type FeedLot,
  type DemandTiers,
} from '../product-feed';

const NOW = new Date('2026-08-07T12:00:00Z');

function lot(overrides: Partial<FeedLot> = {}): FeedLot {
  return {
    id: 'fa682dff-1729-4031-8bfc-d951ee379e65',
    lot_code: 'TEA4951511',
    qr_token: 'd94b0d62-b7aa-4129-9e14-c5f77e0a0315',
    title: 'JOOM Tripod Clothes Drying Rack',
    description: 'Folding garment rack.',
    condition: 'good',
    status: 'live',
    photo_urls: ['https://cdn.example.com/a.jpg'],
    current_bid_cents: 700,
    starting_bid_cents: 100,
    msrp_cents: 12999,
    close_at: '2026-08-07T23:00:00Z',
    bid_count: 4,
    auctions: { title: 'Thursday Night Closeout' },
    categories: { name: 'Home & Garden' },
    ...overrides,
  };
}

describe('metaCondition', () => {
  it('maps unused returns to new and everything else to used', () => {
    expect(metaCondition('appears_new')).toBe('new');
    expect(metaCondition('open_box')).toBe('new');
    expect(metaCondition('good')).toBe('used');
    expect(metaCondition('as_is')).toBe('used');
  });

  // Overstating condition is what draws policy strikes, so an enum value we
  // don't recognise must degrade to `used`, never to `new`.
  it('falls back to used for unknown or missing values', () => {
    expect(metaCondition('sparkling')).toBe('used');
    expect(metaCondition(null)).toBe('used');
    expect(metaCondition(undefined)).toBe('used');
  });
});

describe('formatPrice', () => {
  it('renders cents as Meta currency strings', () => {
    expect(formatPrice(700)).toBe('7.00 USD');
    expect(formatPrice(12999)).toBe('129.99 USD');
  });

  // Meta rejects a zero price outright, which would drop the row.
  it('floors zero and negative to one cent', () => {
    expect(formatPrice(0)).toBe('0.01 USD');
    expect(formatPrice(null)).toBe('0.01 USD');
    expect(formatPrice(-500)).toBe('0.01 USD');
  });
});

describe('clampText', () => {
  it('leaves short text alone and collapses whitespace', () => {
    expect(clampText('  a   b  ', 200)).toBe('a b');
  });

  it('truncates on a word boundary', () => {
    const out = clampText('alpha bravo charlie delta', 18);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('charl ');
  });
});

describe('toFeedRow — availability is the takedown mechanism', () => {
  it('marks an open lot in stock and sellable', () => {
    const row = toFeedRow(lot(), NOW)!;
    expect(row.availability).toBe('in stock');
    expect(row.quantity_to_sell_on_facebook).toBe('1');
  });

  // The whole point of the feature: once the clock passes, the row must still
  // be emitted, but as an explicit stop signal rather than vanishing.
  it('marks a closed lot out of stock rather than dropping it', () => {
    const row = toFeedRow(lot({ close_at: '2026-08-07T11:00:00Z', status: 'won' }), NOW)!;
    expect(row).not.toBeNull();
    expect(row.availability).toBe('out of stock');
    expect(row.quantity_to_sell_on_facebook).toBe('0');
    expect(row.description).toContain('This auction has ended.');
  });

  // Status lags the clock (the close worker runs on an interval); the clock
  // lags a lot pulled early. Either one going closed must close the row.
  it('treats a past close_at as closed even while status still says live', () => {
    const row = toFeedRow(lot({ close_at: '2026-08-07T11:59:59Z', status: 'live' }), NOW)!;
    expect(row.availability).toBe('out of stock');
  });

  it('treats a withdrawn lot as closed even though the clock has not passed', () => {
    const row = toFeedRow(lot({ status: 'canceled' }), NOW)!;
    expect(row.availability).toBe('out of stock');
  });
});

describe('toFeedRow — the closing window', () => {
  // 23.6% of all bids land in the final 60 minutes (seven days of prod bids).
  // A lot advertised inside that window is priced at its most wrong AND will
  // be shut before Meta fetches again, so it stops being advertised — while
  // staying in the feed, because a dropped row is the weak takedown signal.
  it('withholds a lot that will close before the next fetch', () => {
    // 45 minutes out: still running, inside the 90-minute window.
    const row = toFeedRow(lot({ close_at: '2026-08-07T12:45:00Z' }), NOW)!;
    expect(row.availability).toBe('out of stock');
    expect(row.quantity_to_sell_on_facebook).toBe('0');
  });

  it('keeps it in the feed rather than dropping it, so Meta gets the strong signal', () => {
    const row = toFeedRow(lot({ close_at: '2026-08-07T12:45:00Z' }), NOW);
    expect(row).not.toBeNull();
    expect(row!.id).toBe('fa682dff-1729-4031-8bfc-d951ee379e65');
  });

  it('does NOT call a closing lot ended — it has not ended', () => {
    // The bug this guards: withholding delivery made the open/closed boolean
    // wrong, and a lot closing in 45 minutes was described as having ended.
    const row = toFeedRow(lot({ close_at: '2026-08-07T12:45:00Z' }), NOW)!;
    expect(row.description).toContain('Closing soon');
    expect(row.description).not.toContain('has ended');
  });

  it('still advertises a lot comfortably outside the window', () => {
    // 91 minutes out — one minute clear of the cutoff.
    const row = toFeedRow(lot({ close_at: '2026-08-07T13:31:00Z' }), NOW)!;
    expect(row.availability).toBe('in stock');
    expect(row.description).toContain('place your bid');
  });

  it('a genuinely ended lot still reads as ended, not closing', () => {
    const row = toFeedRow(lot({ close_at: '2026-08-07T11:00:00Z', status: 'won' }), NOW)!;
    expect(row.description).toContain('has ended');
    expect(row.description).not.toContain('Closing soon');
  });

  it('the window exceeds an hourly fetch, or lots close inside the gap', () => {
    expect(FEED_CLOSING_SOON_MINUTES).toBeGreaterThan(60);
  });
});

describe('toFeedRow — required fields', () => {
  it('drops a lot with no photo, since Meta requires image_link', () => {
    expect(toFeedRow(lot({ photo_urls: [] }), NOW)).toBeNull();
    expect(toFeedRow(lot({ photo_urls: null }), NOW)).toBeNull();
  });

  it('drops a lot with no title or no close time', () => {
    expect(toFeedRow(lot({ title: '   ' }), NOW)).toBeNull();
    expect(toFeedRow(lot({ close_at: null }), NOW)).toBeNull();
  });

  it('uses the lot UUID as id so a relist becomes a distinct item', () => {
    const row = toFeedRow(lot(), NOW)!;
    expect(row.id).toBe('fa682dff-1729-4031-8bfc-d951ee379e65');
  });

  // /l/{qr_token} is the only path claimed by both the AASA and assetlinks
  // files, so it is the only link shape that opens the app from an ad.
  it('links via the /l/ short form that deep-links into the app', () => {
    expect(toFeedRow(lot(), NOW)!.link).toBe(
      'https://bingoauctions.com/l/d94b0d62-b7aa-4129-9e14-c5f77e0a0315',
    );
  });

  it('falls back to the long lot URL when a lot predates qr_token backfill', () => {
    expect(toFeedRow(lot({ qr_token: null }), NOW)!.link).toBe(
      'https://bingoauctions.com/lot/TEA4951511',
    );
  });

  it('advertises the current bid, never MSRP', () => {
    const row = toFeedRow(lot({ current_bid_cents: 700, msrp_cents: 12999 }), NOW)!;
    expect(row.price).toBe('7.00 USD');
    // Retail value is honest context, but only as prose.
    expect(row.description).toContain('Estimated retail value $129.99.');
  });

  it('falls back to the starting bid before any bids land', () => {
    expect(toFeedRow(lot({ current_bid_cents: null }), NOW)!.price).toBe('1.00 USD');
  });

  it('carries extra photos and segmentation labels', () => {
    const row = toFeedRow(
      lot({ photo_urls: ['https://c/1.jpg', 'https://c/2.jpg', 'https://c/3.jpg'] }),
      NOW,
    )!;
    expect(row.additional_image_link).toBe('https://c/2.jpg,https://c/3.jpg');
    expect(row.custom_label_0).toBe('Thursday Night Closeout');
    expect(row.custom_label_1).toBe('2026-08-07');
    expect(row.product_type).toBe('Home & Garden');
  });

  // Labels 2 and 3 are what the ad product sets filter on, so a wrong or
  // missing value here does not break the feed — it silently empties the
  // campaign, which is the failure nobody notices.
  it('stamps the category demand tier onto custom_label_2', () => {
    const tiers: DemandTiers = new Map([['home & garden', 'proven']]);
    expect(toFeedRow(lot(), NOW, tiers)!.custom_label_2).toBe('proven');
  });

  // The map is built from the DB's category names and the lot carries its own
  // copy of that name through an embed; case or padding differing between the
  // two must not silently demote a proven category to unproven.
  it('matches the tier case- and whitespace-insensitively', () => {
    const tiers: DemandTiers = new Map([['patio furniture', 'proven']]);
    const row = toFeedRow(lot({ categories: { name: '  Patio Furniture ' } }), NOW, tiers)!;
    expect(row.custom_label_2).toBe('proven');
  });

  // Absent evidence is 'unproven', never blank and never 'slow'. Blank matches
  // no product-set rule at all, and 'slow' would assert a bad result we do not
  // have. Both are the wrong answer to "we don't know yet".
  it('falls back to unproven for an unranked or missing category', () => {
    expect(toFeedRow(lot(), NOW, new Map())!.custom_label_2).toBe('unproven');
    expect(toFeedRow(lot({ categories: null }), NOW, new Map())!.custom_label_2).toBe('unproven');
  });

  it('buckets the lot\'s own bidding into custom_label_3', () => {
    expect(toFeedRow(lot({ bid_count: 0 }), NOW)!.custom_label_3).toBe('bids-0');
    expect(toFeedRow(lot({ bid_count: 9 }), NOW)!.custom_label_3).toBe('bids-6-plus');
  });
});

describe('bidActivityLabel', () => {
  it('buckets on the boundaries', () => {
    expect(bidActivityLabel(0)).toBe('bids-0');
    expect(bidActivityLabel(1)).toBe('bids-1-2');
    expect(bidActivityLabel(2)).toBe('bids-1-2');
    expect(bidActivityLabel(3)).toBe('bids-3-5');
    expect(bidActivityLabel(5)).toBe('bids-3-5');
    expect(bidActivityLabel(6)).toBe('bids-6-plus');
  });

  // A null counter is "no bids recorded", which is bids-0 — not a blank label
  // that would drop the lot out of every rule that mentions label 3.
  it('treats null and negative as no activity', () => {
    expect(bidActivityLabel(null)).toBe('bids-0');
    expect(bidActivityLabel(undefined)).toBe('bids-0');
    expect(bidActivityLabel(-3)).toBe('bids-0');
  });
});

describe('FEED_AUCTION_STATUSES', () => {
  // The shipped feed returned 500 on every request because this list contained
  // "ended", which is not a member of the auction_status enum — PostgREST
  // rejected the query with 22P02 and buildMetaFeed threw. Pinning the enum
  // here makes an invented value fail in CI instead of in production.
  const AUCTION_STATUS_ENUM = ['draft', 'scheduled', 'live', 'closed', 'canceled'];

  it('only contains real auction_status enum members', () => {
    for (const s of FEED_AUCTION_STATUSES) {
      expect(AUCTION_STATUS_ENUM).toContain(s);
    }
  });

  it('excludes draft, which was never public', () => {
    expect(FEED_AUCTION_STATUSES).not.toContain('draft');
  });

  // Excluding canceled would make its lots vanish from the feed (weak signal)
  // instead of going out-of-stock (strong signal) — the exact failure mode the
  // tail window exists to prevent.
  it('includes canceled so its lots get an explicit out-of-stock', () => {
    expect(FEED_AUCTION_STATUSES).toContain('canceled');
  });
});

describe('orderPhotosForAds', () => {
  // Shape taken from prod lot BIN-007578: a retail-CDN hotlink at index 0 and
  // our own re-hosted copy at index 1.
  const AMAZON = 'https://m.media-amazon.com/images/I/81SnWkQiKnL._AC_SX679_.jpg';
  const OURS =
    'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/op/BIN-007578/1.jpg';

  it('promotes a self-hosted photo ahead of a retail-CDN hotlink', () => {
    expect(orderPhotosForAds([AMAZON, OURS])).toEqual([OURS, AMAZON]);
  });

  it('keeps relative order within each group', () => {
    const ours2 = OURS.replace('1.jpg', '2.jpg');
    expect(orderPhotosForAds([AMAZON, OURS, ours2])).toEqual([OURS, ours2, AMAZON]);
  });

  it('still yields an image when every photo is a hotlink', () => {
    expect(orderPhotosForAds([AMAZON])).toEqual([AMAZON]);
  });

  it('makes image_link the self-hosted, proxied, absolute URL', () => {
    const row = toFeedRow(lot({ photo_urls: [AMAZON, OURS] }), NOW)!;
    expect(row.image_link).toBe('https://bingoauctions.com/img/lot-photos/op/BIN-007578/1.jpg');
    expect(row.additional_image_link).toBe(AMAZON);
  });
});

describe('CSV serialization', () => {
  // Real lot titles contain commas and inch marks; unquoted output would
  // shift every subsequent column.
  it('quotes and doubles embedded quotes', () => {
    expect(csvEscape('24" Monitor, Black')).toBe('"24"" Monitor, Black"');
  });

  it('emits the header row and one record per lot', () => {
    const csv = toCsv([toFeedRow(lot(), NOW)!]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(FEED_COLUMNS.join(','));
    expect(lines[1]!.startsWith('"fa682dff-1729-4031-8bfc-d951ee379e65"')).toBe(true);
  });

  it('keeps the column count stable when fields contain separators', () => {
    const csv = toCsv([toFeedRow(lot({ title: 'Rack, 24" tall' }), NOW)!]);
    const record = csv.trimEnd().split('\n')[1]!;
    // Count only the commas that sit between quoted fields.
    expect(record.match(/","/g)!.length).toBe(FEED_COLUMNS.length - 1);
  });

  it('ends with a trailing newline', () => {
    expect(toCsv([toFeedRow(lot(), NOW)!]).endsWith('\n')).toBe(true);
  });
});
