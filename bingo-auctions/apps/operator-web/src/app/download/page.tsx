/**
 * /download — public marketing page.
 *
 * Bidder app download page. Required by both the Apple App Store and
 * Google Play Store as a publicly accessible app information page — App
 * Store reviewers at apple.com/app-store/review/ expect to find this at
 * the URL listed in the App Store listing.
 *
 * Content:
 *   - iOS download section (App Store badge)
 *   - Android download section (Google Play badge)
 *   - Brief explanation of what the bidder app does
 *   - "One account, every BinGo auction" messaging
 *
 * Store URLs come from lib/app-links — do NOT hardcode them here again.
 * Both links on this page were broken until 2026-08-07: the Apple badge
 * pointed at ASC record 6767012532, which never received a build and returned
 * 404, and the Android half was still a "coming soon" mailto months after the
 * app went live on Play. See lib/app-links for the live identifiers.
 *
 * Badge artwork is inline SVG traced from each store's published assets, per
 * https://developer.apple.com/app-store/marketing/guidelines/ and
 * https://play.google.com/intl/en_us/badges/ — no remote image dependency.
 *
 * Server component. No new dependencies. Design tokens from globals.css.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { APP_STORE_URL, PLAY_STORE_URL } from '@/lib/app-links';

export const metadata: Metadata = {
  title: { absolute: 'Get the BinGo Auctions App' },
  description:
    'Download the BinGo Auctions app for iPhone or Android to bid on live online auctions, win lots, and schedule local pickup.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 628 }],
  },
};

const MAX_W = 860;

const pageWrap: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  minHeight: '100vh',
};

const innerWrap: React.CSSProperties = {
  maxWidth: MAX_W,
  margin: '0 auto',
  padding: '0 1.5rem',
};

export default function DownloadPage() {
  return (
    <div style={pageWrap}>
      {/* Back nav */}
      <div style={{ ...innerWrap, paddingTop: '2rem' }}>
        <Link href="/" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
          &larr; BinGo Auctions
        </Link>
      </div>

      {/* Header */}
      <header style={{ ...innerWrap, padding: '4rem 1.5rem 3rem' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: '0.75rem',
          }}
        >
          Bidder app
        </div>
        <h1
          style={{
            fontSize: 'clamp(2rem, 5vw, 3rem)',
            fontWeight: 900,
            letterSpacing: -1.5,
            lineHeight: 1.08,
            margin: '0 0 1rem',
          }}
        >
          Bid from anywhere.<br />Pick up on your schedule.
        </h1>
        <p
          style={{
            color: 'var(--fg-muted)',
            fontSize: '1.1rem',
            lineHeight: 1.65,
            maxWidth: 560,
            margin: 0,
          }}
        >
          The BinGo Auctions app lets you browse, bid on, win, and pick up lots from
          every BinGo Auctions auction — with a single account and a single login.
        </p>
      </header>

      {/* App sections */}
      <section style={{ ...innerWrap, paddingBottom: '4rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1.5rem',
          }}
        >
          {/* iOS card */}
          <div
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '2rem',
            }}
          >
            <div style={{ fontSize: 36, marginBottom: '0.75rem' }}>&#63743;</div>
            <h2
              style={{
                fontSize: '1.3rem',
                fontWeight: 900,
                letterSpacing: -0.5,
                margin: '0 0 0.5rem',
              }}
            >
              BinGo Auctions for iOS
            </h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.65, margin: '0 0 1.5rem' }}>
              Available on iPhone. Requires iOS 16 or later.
              Bid live, get outbid alerts, track your wins, and navigate the warehouse
              on pickup day — all from the app.
            </p>

            {/* App Store badge — canonical URL from lib/app-links. */}
            <a
              href={APP_STORE_URL}
              aria-label="Download BinGo Auctions on the App Store"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block' }}
            >
              <AppStoreBadge />
            </a>

            <div style={{ marginTop: '1.25rem' }}>
              <FeatureList
                items={[
                  'Browse live and upcoming auctions',
                  'Real-time bidding with soft-close',
                  'Outbid push notifications',
                  'Invoice + payment on win',
                  'Pickup scheduling',
                  'Warehouse walking route',
                ]}
              />
            </div>
          </div>

          {/* Android card */}
          <div
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '2rem',
            }}
          >
            <h2
              style={{
                fontSize: '1.3rem',
                fontWeight: 900,
                letterSpacing: -0.5,
                margin: '0 0 0.5rem',
              }}
            >
              BinGo Auctions for Android
            </h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.65, margin: '0 0 1.5rem' }}>
              Available on Android phones and tablets.
              Bid live, get outbid alerts, track your wins, and navigate the warehouse
              on pickup day — all from the app.
            </p>

            {/* Play badge — canonical URL from lib/app-links. */}
            <a
              href={PLAY_STORE_URL}
              aria-label="Get BinGo Auctions on Google Play"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block' }}
            >
              <GooglePlayBadge />
            </a>

            <div style={{ marginTop: '1.25rem' }}>
              <FeatureList
                items={[
                  'Browse live and upcoming auctions',
                  'Real-time bidding with soft-close',
                  'Outbid push notifications',
                  'Invoice + payment on win',
                  'Pickup scheduling',
                  'Warehouse walking route',
                ]}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Feature callouts */}
      <section
        style={{
          background: 'var(--bg-elev)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          padding: '4rem 1.5rem',
        }}
      >
        <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 900,
              letterSpacing: -0.75,
              margin: '0 0 2rem',
            }}
          >
            One app. Every BinGo Auctions auction.
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '1.25rem',
            }}
          >
            <AppFeatureCard
              icon="&#128273;"
              title="Single account, every auction"
              body="Create one BinGo Auctions account. Your bidder identity, payment method, and bid history
              work across every BinGo Auctions auction — every event, every warehouse, one login."
            />
            <AppFeatureCard
              icon="&#9889;"
              title="Real-time bidding"
              body="BinGo Auctions uses a soft-close model — lots extend when bids arrive near the close.
              You get push notifications when you're outbid, so you never miss a chance to
              respond without staring at the screen."
            />
            <AppFeatureCard
              icon="&#128506;"
              title="Warehouse maps on pickup day"
              body="After you win and pay, the app shows you a walking route through the warehouse
              to every lot you won. No paper lists. No waiting for staff. Scan your QR code at
              the door and walk straight to your items."
            />
            <AppFeatureCard
              icon="&#128179;"
              title="Seamless payment"
              body="Your winning invoice is generated automatically at auction close. Payment processes
              from the card on file — no checkout friction, no PayPal redirect. Dispute within
              the auctioneer's return window if an item is not as described."
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          padding: '2rem 1.5rem',
          borderTop: '1px solid var(--border)',
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--fg-dim)',
        }}
      >
        &copy; 2026 BinGo Auctions &nbsp;&middot;&nbsp;
        <Link href="/legal/terms" style={{ color: 'var(--fg-dim)' }}>Terms</Link>
        &nbsp;&middot;&nbsp;
        <Link href="/legal/privacy" style={{ color: 'var(--fg-dim)' }}>Privacy</Link>
        &nbsp;&middot;&nbsp;
        <Link href="/support" style={{ color: 'var(--fg-dim)' }}>Support</Link>
        &nbsp;&middot;&nbsp;
        <Link href="/legal/bidder-agreement" style={{ color: 'var(--fg-dim)' }}>Bidder Agreement</Link>
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.4rem' }}>
      {items.map((item) => (
        <li
          key={item}
          style={{ fontSize: 13, color: 'var(--fg-muted)', display: 'flex', gap: '0.5rem' }}
        >
          <span style={{ color: 'var(--accent)', flexShrink: 0 }}>&#10003;</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function AppFeatureCard({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '1.25rem',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: '0.6rem' }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.4rem' }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--fg-muted)' }}>{body}</div>
    </div>
  );
}

/**
 * Official Apple App Store badge.
 * SVG derived from Apple's marketing guidelines badge artwork.
 * Dark variant (black background) is appropriate here given dark site theme.
 * Per Apple guidelines: minimum 40px height, no modification to badge shape.
 */
/**
 * Google Play badge, inline SVG at the same 135x40 footprint as the Apple one
 * so the two cards line up. Same approach the App Store badge already takes:
 * path data traced from the published badge rather than a remote asset, per
 * https://play.google.com/intl/en_us/badges/ brand guidelines.
 */
function GooglePlayBadge() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="135"
      height="40"
      viewBox="0 0 135 40"
      role="img"
      aria-label="Get it on Google Play"
    >
      <rect width="135" height="40" rx="8" ry="8" fill="#000" />
      <rect
        x="0.5"
        y="0.5"
        width="134"
        height="39"
        rx="7.5"
        ry="7.5"
        fill="none"
        stroke="#a6a6a6"
        strokeWidth="1"
      />
      {/* Play triangle — four folded segments meeting at the right point. */}
      <g transform="translate(10.5, 8.2) scale(0.99)">
        <path d="M0.6 0.6C0.2 1 0 1.6 0 2.4v19.2c0 0.8 0.2 1.4 0.6 1.8l0.1 0.1L11.4 12.8v-0.2z" fill="#00D7FE" />
        <path d="M14.9 16.3l-3.5-3.5v-0.3l3.5-3.5 0.1 0.1 4.2 2.4c1.2 0.7 1.2 1.8 0 2.5z" fill="#FFBC00" />
        <path d="M15 16.2l-3.6-3.5L0.6 23.5c0.4 0.4 1.1 0.5 1.8 0.1z" fill="#FF3A44" />
        <path d="M15 9.2L2.4 2.2C1.7 1.8 1 1.9 0.6 2.3l10.8 10.4z" fill="#00F076" />
      </g>
      {/* Wordmark */}
      <text
        x="41"
        y="16"
        fill="#fff"
        fontFamily="Roboto, Arial, Helvetica, sans-serif"
        fontSize="8"
        letterSpacing="0.8"
      >
        GET IT ON
      </text>
      <text
        x="41"
        y="31"
        fill="#fff"
        fontFamily="Roboto, Arial, Helvetica, sans-serif"
        fontSize="16"
        fontWeight="500"
        letterSpacing="-0.3"
      >
        Google Play
      </text>
    </svg>
  );
}

function AppStoreBadge() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="135"
      height="40"
      viewBox="0 0 135 40"
      role="img"
      aria-label="Download on the App Store"
    >
      {/* Background */}
      <rect width="135" height="40" rx="8" ry="8" fill="#000" />
      <rect
        x="0.5"
        y="0.5"
        width="134"
        height="39"
        rx="7.5"
        ry="7.5"
        fill="none"
        stroke="#a6a6a6"
        strokeWidth="1"
      />
      {/* Apple logo mark */}
      <path
        d="M24.77 20.3a5.2 5.2 0 0 1 2.48-4.37 5.33 5.33 0 0 0-4.2-2.27c-1.77-.18-3.48 1.06-4.38 1.06-.92 0-2.3-1.04-3.8-1.01a5.59 5.59 0 0 0-4.7 2.87c-2.03 3.52-.52 8.7 1.44 11.55.97 1.39 2.1 2.95 3.59 2.9 1.45-.06 2-.93 3.75-.93 1.74 0 2.25.93 3.77.9 1.56-.03 2.54-1.4 3.48-2.8a11.5 11.5 0 0 0 1.58-3.26 5.03 5.03 0 0 1-3.01-4.64z"
        fill="#fff"
      />
      <path
        d="M21.84 12.1a5.13 5.13 0 0 0 1.17-3.67 5.22 5.22 0 0 0-3.38 1.75 4.88 4.88 0 0 0-1.2 3.54 4.32 4.32 0 0 0 3.41-1.62z"
        fill="#fff"
      />
      {/* "Download on the" text */}
      <text x="38" y="14" fill="#fff" fontSize="9" fontFamily="-apple-system, Helvetica, Arial, sans-serif" letterSpacing="0.3">
        Download on the
      </text>
      {/* "App Store" text */}
      <text
        x="38"
        y="29"
        fill="#fff"
        fontSize="17"
        fontWeight="600"
        fontFamily="-apple-system, Helvetica, Arial, sans-serif"
        letterSpacing="-0.3"
      >
        App Store
      </text>
    </svg>
  );
}
