/**
 * robots.txt — generated from this Next.js metadata route.
 *
 * Allow crawlers on the bidder-facing surface (homepage, /browse, /auction,
 * /lot, marketing pages). Disallow everything in the operator console
 * subtree — those routes are auth-gated anyway, but we don't want search
 * engines indexing 401 shells.
 */

import type { MetadataRoute } from 'next';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: [
          '/admin/',
          '/dashboard/',
          '/auctions/',
          '/lots/',
          '/onboarding/',
          '/account/',
          '/billing/',
          '/payouts/',
          '/staff/',
          '/settlements/',
          '/disputes/',
          '/reports/',
          '/imports/',
          '/lotting/',
          '/lottr/',
          '/pickups/',
          '/shipping/',
          '/warehouses/',
          '/inventory/',
          '/ops/',
          '/api/',
          '/auth/',
          '/qr/',
        ],
      },
    ],
    sitemap: 'https://bingoauctions.com/sitemap.xml',
  };
}
