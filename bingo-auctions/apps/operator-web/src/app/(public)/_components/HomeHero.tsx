/**
 * HomeHero — clean, type-forward homepage hero (light theme).
 *
 * No external/CDN image: a light section with the headline, subline, and a
 * tangerine CTA, plus a soft accent wash. Props allow copy overrides for A/B
 * testing without touching JSX. The "How it works" / "Get the app" strip sits
 * below as a quick-access row.
 */

import Link from 'next/link';

export interface HomeHeroProps {
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
  ctaHref?: string;
}

export function HomeHero({
  title = 'Better deals. Better bids.',
  subtitle = 'Online auctions run by the people who run them — browse live lots, bid, and pick up locally. Treasure hunting, on a timer.',
  ctaLabel = 'Browse the board',
  ctaHref = '/browse',
}: HomeHeroProps) {
  return (
    <div>
      {/* ── Hero band (light, type-forward) ── */}
      <section
        aria-label="Homepage hero"
        className="home-hero-section"
        style={{
          position: 'relative',
          width: '100%',
          background: 'linear-gradient(180deg, #1c2e49 0%, var(--bg) 100%)',
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {/* Photographic hero — bright unboxing lifestyle photo (generated
            in-house: gen-brand-art.mjs `photos` stage, vision-judge
            validated). Owner direction 2026-07-03: photorealistic like
            BinGo/mac.bid/nellis, not flat illustration. The left gradient
            keeps the headline legible over the bright image. */}
        <img
          src="/art/photo/hero-photo.webp"
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'right center',
            opacity: 0.9,
            pointerEvents: 'none',
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(90deg, rgba(21,35,58,0.97) 0%, rgba(21,35,58,0.88) 34%, rgba(21,35,58,0.45) 62%, rgba(21,35,58,0.12) 100%)',
            pointerEvents: 'none',
          }}
        />
        {/* Soft magenta + gold "daub" glows, top-right — the dauber motif as
            ambient color layered over the art. */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: -120,
            right: -120,
            width: 420,
            height: 420,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 35% 35%, var(--accent-dim), transparent 62%)',
            pointerEvents: 'none',
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 40,
            right: 180,
            width: 220,
            height: 220,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 50% 50%, var(--gold-dim), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            maxWidth: 1100,
            width: '100%',
            margin: '0 auto',
            padding: 'clamp(3.5rem, 7vw, 6rem) 1.5rem',
          }}
        >
          <div style={{ maxWidth: 640 }}>
            <div
              className="font-mono"
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                margin: '0 0 18px',
              }}
            >
              <span aria-hidden className="daub" style={{ width: 10, height: 10 }} />
              Local-pickup auctions
            </div>

            <h1
              style={{
                fontSize: 'clamp(2.4rem, 6vw, 4.4rem)',
                fontWeight: 600,
                letterSpacing: -0.5,
                lineHeight: 1.04,
                margin: '0 0 1.1rem',
                color: 'var(--ink-2)',
              }}
            >
              {title}
            </h1>

            <p
              style={{
                fontSize: 'clamp(1.05rem, 2vw, 1.25rem)',
                lineHeight: 1.55,
                color: 'var(--fg-muted)',
                margin: '0 0 2rem',
                maxWidth: 500,
              }}
            >
              {subtitle}
            </p>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {/* The hero used to hand-roll both of these inline, which is how
                  the site ended up with two near-copies of .btn-primary that
                  drifted on padding and hover. They are the shared buttons at
                  the large size now — including the hover, which .btn-primary
                  already provided. */}
              <Link href={ctaHref} className="btn-primary btn-lg">
                {ctaLabel} <span style={{ marginLeft: '0.35em' }}>&rarr;</span>
              </Link>
              <Link href="/how-it-works" className="btn-secondary btn-lg">
                How it works
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Quick-access strip ── */}
      <div
        style={{
          background: 'var(--bg-elev)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '0 1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '1.5rem',
            height: 48,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <Link
            href="/how-it-works"
            style={{
              color: 'var(--fg-muted)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden style={{ fontSize: 15 }}>
              {'❓'}
            </span>
            How it works
          </Link>

          <span aria-hidden style={{ color: 'var(--border)', userSelect: 'none' }}>
            |
          </span>

          <Link
            href="/download"
            style={{
              color: 'var(--fg-muted)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden style={{ fontSize: 15 }}>
              {'\u{1F4F1}'}
            </span>
            Get the app
          </Link>
        </div>
      </div>

    </div>
  );
}
