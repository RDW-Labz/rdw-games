/**
 * SEO / AI-search structured data helpers.
 *
 * Every public page injects schema.org JSON-LD through <JsonLd> so Google,
 * Bing, and LLM crawlers (GPTBot, ClaudeBot, PerplexityBot — all allowed by
 * robots.ts) can read the site as data instead of scraping prose:
 *
 *   - homepage        → Organization + WebSite (sitelinks search) + LocalBusiness
 *   - /lot/{code}     → Product (+ Offer at the current bid) + BreadcrumbList
 *   - /auction/{id}   → SaleEvent
 *   - /how-it-works   → FAQPage (mirrors the visible FAQ section)
 *
 * NOTE (2026-07-06): auction-priced products are barred from Google
 * Merchant Center / Shopping feeds, but Product JSON-LD for ORGANIC
 * results has no fixed-price requirement — the Offer here reflects the
 * live bid and carries availabilityEnds so stale snippets self-expire.
 *
 * Business identity (name, address, hours) is read from the operator +
 * warehouse rows, never hardcoded — single-operator platform, so "the
 * first operator's first warehouse" IS the business.
 */

import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const SITE_URL = 'https://bingoauctions.com';

// ─── <JsonLd> ────────────────────────────────────────────────────────────────

/**
 * Renders a schema.org JSON-LD block. `<` is escaped to < so a lot
 * title/description containing "</script>" can't break out of the tag.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

// ─── Business identity (operator + warehouse) ────────────────────────────────

export type PrimaryBusiness = {
  name: string;
  email: string | null;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  } | null;
  /** warehouses.pickup_hours JSONB — { "mon": [{ "open": "10:00", "close": "18:00" }] } */
  pickupHours: Record<string, Array<{ open: string; close: string }>> | null;
};

/**
 * The platform's single operator + their first warehouse. React cache() —
 * at most one lookup per render pass even when several builders need it.
 */
export const loadPrimaryBusiness = cache(async (): Promise<PrimaryBusiness | null> => {
  try {
    const admin = getSupabaseAdmin();
    const { data: op } = await admin
      .from('operators')
      .select('id, business_name, contact_email')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!op) return null;
    const opRow = op as { id: string; business_name: string | null; contact_email: string | null };

    const { data: wh } = await admin
      .from('warehouses')
      .select('address_line1, address_line2, city, state, postal_code, country, pickup_hours')
      .eq('operator_id', opRow.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const whRow = wh as {
      address_line1: string;
      address_line2: string | null;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      pickup_hours: Record<string, Array<{ open: string; close: string }>> | null;
    } | null;

    return {
      name: opRow.business_name ?? 'BinGo Auctions',
      email: opRow.contact_email ?? null,
      address: whRow
        ? {
            line1: whRow.address_line1,
            line2: whRow.address_line2,
            city: whRow.city,
            state: whRow.state,
            postalCode: whRow.postal_code,
            country: whRow.country || 'US',
          }
        : null,
      pickupHours: whRow?.pickup_hours ?? null,
    };
  } catch {
    return null;
  }
});

// ─── Builders ────────────────────────────────────────────────────────────────

export function organizationJsonLd(biz: PrimaryBusiness | null): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#org`,
    name: biz?.name ?? 'BinGo Auctions',
    url: SITE_URL,
    logo: `${SITE_URL}/og-default.png`,
    ...(biz?.email ? { email: biz.email } : {}),
  };
}

export function webSiteJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: 'BinGo Auctions',
    url: SITE_URL,
    publisher: { '@id': `${SITE_URL}/#org` },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/browse?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

const DAY_MAP: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export function localBusinessJsonLd(biz: PrimaryBusiness): Record<string, unknown> {
  const hours = Object.entries(biz.pickupHours ?? {})
    .filter(([day, windows]) => DAY_MAP[day] && Array.isArray(windows) && windows.length > 0)
    .flatMap(([day, windows]) =>
      windows
        .filter((w) => w && typeof w.open === 'string' && typeof w.close === 'string')
        .map((w) => ({
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: DAY_MAP[day],
          opens: w.open,
          closes: w.close,
        })),
    );

  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${SITE_URL}/#business`,
    name: biz.name,
    url: SITE_URL,
    image: `${SITE_URL}/og-default.png`,
    description:
      'Online liquidation auction house — overstock, returns, and closeout inventory sold in timed online auctions with local warehouse pickup.',
    ...(biz.email ? { email: biz.email } : {}),
    ...(biz.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: [biz.address.line1, biz.address.line2].filter(Boolean).join(', '),
            addressLocality: biz.address.city,
            addressRegion: biz.address.state,
            postalCode: biz.address.postalCode,
            addressCountry: biz.address.country,
          },
        }
      : {}),
    ...(hours.length > 0 ? { openingHoursSpecification: hours } : {}),
    parentOrganization: { '@id': `${SITE_URL}/#org` },
  };
}

// lots.condition enum → schema.org OfferItemCondition. open_box/good/as_is
// all map to UsedCondition: schema.org has no open-box value and calling
// as-is "Damaged" would overstate typical condition.
const CONDITION_MAP: Record<string, string> = {
  appears_new: 'https://schema.org/NewCondition',
  open_box: 'https://schema.org/UsedCondition',
  good: 'https://schema.org/UsedCondition',
  as_is: 'https://schema.org/UsedCondition',
};

export function productJsonLd(args: {
  lotCode: string;
  title: string;
  description: string | null;
  photoUrls: string[];
  brand: string | null;
  model: string | null;
  upc: string | null;
  mpn: string | null;
  condition: string;
  status: string;
  priceCents: number;
  closeAt: string | null;
  sellerName: string;
}): Record<string, unknown> {
  const url = `${SITE_URL}/lot/${args.lotCode}`;
  const biddable = args.status === 'live' || args.status === 'scheduled';
  const gtin = args.upc && /^\d{8}$|^\d{12,14}$/.test(args.upc) ? args.upc : null;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.photoUrls.length > 0 ? { image: args.photoUrls } : {}),
    sku: args.lotCode,
    ...(gtin ? { gtin } : {}),
    ...(args.mpn ? { mpn: args.mpn } : {}),
    ...(args.brand ? { brand: { '@type': 'Brand', name: args.brand } } : {}),
    ...(args.model ? { model: args.model } : {}),
    itemCondition: CONDITION_MAP[args.condition] ?? 'https://schema.org/UsedCondition',
    offers: {
      '@type': 'Offer',
      url,
      // Current high bid (or starting bid) — a floor, not a buy-now price.
      price: (args.priceCents / 100).toFixed(2),
      priceCurrency: 'USD',
      availability: biddable ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
      ...(biddable && args.closeAt ? { availabilityEnds: args.closeAt } : {}),
      seller: { '@type': 'Organization', name: args.sellerName },
    },
  };
}

export function breadcrumbJsonLd(
  items: Array<{ name: string; url: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function auctionEventJsonLd(args: {
  id: string;
  title: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  imageUrl: string | null;
  biz: PrimaryBusiness | null;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SaleEvent',
    name: args.title,
    ...(args.description ? { description: args.description } : {}),
    url: `${SITE_URL}/auction/${args.id}`,
    ...(args.imageUrl ? { image: args.imageUrl } : {}),
    ...(args.startsAt ? { startDate: args.startsAt } : {}),
    ...(args.endsAt ? { endDate: args.endsAt } : {}),
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'VirtualLocation',
      url: `${SITE_URL}/auction/${args.id}`,
    },
    organizer: {
      '@type': 'Organization',
      name: args.biz?.name ?? 'BinGo Auctions',
      url: SITE_URL,
    },
    // Free to attend/bid — required by Google's Event schema validator.
    isAccessibleForFree: true,
  };
}

export function faqPageJsonLd(
  faqs: Array<{ q: string; a: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}
