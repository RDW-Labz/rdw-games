import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Inter, Space_Mono, Syne, Atkinson_Hyperlegible } from 'next/font/google';
import './globals.css';

// BinGo type system — self-hosted via next/font (downloaded at build time,
// served from our own origin; no runtime Google CDN call, no CSP holes).
// "Tuned Playful": modern + confident, not cutesy.
//   Plus Jakarta Sans → clean geometric display for headings + wordmark
//   Inter             → crisp neutral body
//   Space Mono        → lot codes, $ prices, countdown timers (ticket numerals)
const display = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const body = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});
const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
});

const v2Display = Syne({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-v2-display',
  display: 'swap',
  preload: false,
});
const v2Body = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-v2-body',
  display: 'swap',
  preload: false,
});

// BinGo OG card served locally from /public — no external CDN dependency.
const DEFAULT_OG_IMAGE = '/og-default.png';

export const metadata: Metadata = {
  metadataBase: new URL('https://bingoauctions.com'),
  // Google Search Console ownership proof (owner's token, 2026-07-06) —
  // renders <meta name="google-site-verification" ...> on every page. The
  // DNS-record path failed twice in the owner's Cloudflare flow; the
  // HTML-tag method verifies against this instead. Keep indefinitely:
  // Google re-checks it periodically and unverifies the property if it
  // disappears.
  verification: { google: 'C2EjCz62x-zgiD1wrhk2NSLCNSLS1UZo1UNoicfTBh4' },
  title: {
    default: 'BinGo Auctions',
    template: '%s — BinGo Auctions',
  },
  description:
    'Online auctions for home goods, electronics, furniture, and tools. Local pickup.',
  // BinGo mark served locally from /public/favicon.svg (indigo tile + B +
  // tangerine daub) — no external CDN dependency. SVG scales to any tab size.
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/favicon.svg' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'BinGo Auctions',
    images: [{ url: DEFAULT_OG_IMAGE, width: 1200, height: 628 }],
  },
  twitter: {
    card: 'summary_large_image',
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${spaceMono.variable} ${v2Display.variable} ${v2Body.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
