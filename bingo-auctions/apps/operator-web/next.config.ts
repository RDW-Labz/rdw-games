import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@auction-platform/shared'],
  // Manifest imports POST rows to the commitImport server action. The client
  // chunks them (≤800 rows/request), but a chunk of fat rows (now carrying the
  // verbatim source row in raw_data) can edge past Next's 1 MB default. Raise
  // to a modest 4 MB for headroom — kept small on purpose so a single request
  // can't OOM the Cloudflare Worker (the chunk loop, not a big body, is what
  // makes large imports work). Import is admin/manager-gated, so the DDoS
  // surface this guards against is minimal.
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  // The Final Call feature route was renamed /clovrrush -> /final-call in the
  // BinGo rebrand. Permanently redirect the legacy path (and any query string,
  // preserved automatically) so old QR codes / shared links don't 404.
  async redirects() {
    return [
      { source: '/clovrrush', destination: '/final-call', permanent: true },
      { source: '/clovrrush/:path*', destination: '/final-call/:path*', permanent: true },
    ];
  },
  // Emit source maps in production browser bundles so Sentry can symbolicate
  // client-side stack traces. The maps are uploaded to Sentry then deleted
  // from the build output (see withSentryConfig below) so they aren't served
  // publicly.
  productionBrowserSourceMaps: true,
  images: {
    // Allow hosted Supabase Storage in prod and the local dev Supabase via
    // the 127.0.0.1 / localhost variants so <Image> can render bidder
    // photos and operator logos.
    //
    // image-enrichment hosts (added with packages/image-enrichment):
    //   images-na.ssl-images-amazon.com — Amazon ASIN product images
    //   images.openfoodfacts.org        — Open Food Facts community catalog
    //   covers.openlibrary.org          — Open Library book covers
    //   coverartarchive.org             — MusicBrainz Cover Art Archive
    //
    // Keep this list in sync with packages/db/migrations/*_image_url_allowlist*.sql
    // (is_safe_image_url function) and packages/image-enrichment/src/index.ts.
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'cdn.clovrbid.com' },
      { protocol: 'http', hostname: '127.0.0.1' },
      { protocol: 'http', hostname: 'localhost' },
      // image-enrichment: free product image sources
      { protocol: 'https', hostname: 'images-na.ssl-images-amazon.com' },
      { protocol: 'https', hostname: 'images.openfoodfacts.org' },
      { protocol: 'https', hostname: 'covers.openlibrary.org' },
      { protocol: 'https', hostname: 'coverartarchive.org' },
    ],
  },
  // typedRoutes isn't compatible with Turbopack. Re-enable when we move off
  // of Turbopack or when Turbopack ships support.
};

// Wrap with Sentry to upload source maps on production builds. Source-map
// upload is gated on SENTRY_AUTH_TOKEN being present in the build env (set
// in scripts/deploy-cf.sh from the CF Worker secret of the same name) — when
// missing (local dev / unconfigured CI), withSentryConfig logs a warning and
// skips upload rather than failing the build.
//
// Org/project values are the Sentry org slug (rdw-rb) and project slug
// (clovrbid-web). These are public — only the auth token is sensitive.
export default withSentryConfig(nextConfig, {
  org: 'rdw-rb',
  project: 'clovrbid-web',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Release name = git SHA (set by scripts/deploy-cf.sh from
  // `git rev-parse --short HEAD`). Sentry uses this to tie an exception to
  // the exact deployed code revision. Without an explicit release, the
  // Sentry CLI may skip upload entirely (this is what bit our first deploy
  // — releases/ endpoint returned empty). Falls back to `dev-<timestamp>`
  // for local builds.
  release: {
    name: process.env.SENTRY_RELEASE || `dev-${Math.floor(Date.now() / 1000)}`,
  },
  // Silence the build-time CLI output unless something is wrong. Errors
  // still surface; routine "uploaded N files" messages are suppressed.
  // Set silent: false when debugging upload issues.
  silent: false,
  // Delete source maps from the build output after they're uploaded so
  // they aren't served publicly. Sentry still gets them via the upload step.
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Don't fail the build if source-map upload errors — Sentry source maps
  // are a debugging convenience, not a correctness requirement. The error
  // will appear in build logs.
  errorHandler: (err) => {
    console.warn('[sentry] source-map upload error (continuing):', err.message);
  },
});
