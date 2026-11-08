import type { MetadataRoute } from 'next';

// Web app manifest — served at /manifest.webmanifest by Next.js.
// Icon is the local BinGo mark (/public/favicon.svg) — no CDN dependency.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BinGo Auctions',
    short_name: 'BinGo Auctions',
    description: 'Online auctions for home goods, electronics, furniture, and tools. Local pickup.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f3f5f8',
    theme_color: '#fb6514',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
