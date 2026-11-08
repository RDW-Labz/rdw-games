import Link from 'next/link';

// Profile pages (Account, Pickup pass, Invoices, …) live outside the (public)
// route group, so they never inherited PublicNav — a customer inside Account
// had no way back to the homepage except the browser Back button (2026-07-13
// feedback). This slim top bar gives every /profile/* page a Home link via the
// BinGo wordmark, mirroring the logo lockup in (public)/layout.tsx.

const HomeBar = () => (
  <header
    style={{
      position: 'sticky',
      top: 0,
      zIndex: 20,
      background: 'var(--bg-elev)',
      borderBottom: '1px solid var(--border)',
      backdropFilter: 'saturate(140%) blur(6px)',
    }}
  >
    <div
      style={{
        maxWidth: 900,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        height: 52,
        padding: '0 1.5rem',
      }}
    >
      <Link
        href="/"
        aria-label="BinGo Auctions home"
        style={{
          display: 'flex',
          alignItems: 'center',
          textDecoration: 'none',
          flexShrink: 0,
        }}
      >
        <span
          aria-label="BinGo Auctions"
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 5,
            lineHeight: 1,
            fontFamily: 'var(--font-display), "Plus Jakarta Sans", system-ui, sans-serif',
          }}
        >
          <span
            style={{
              fontSize: 21,
              fontWeight: 800,
              fontStyle: 'italic',
              letterSpacing: -0.5,
              color: 'var(--fg)',
            }}
          >
            BinGo
          </span>
          <span
            aria-hidden
            style={{
              color: 'var(--accent)',
              fontWeight: 900,
              fontSize: 16,
              transform: 'translateY(-1px)',
            }}
          >
            &#8599;
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: 'var(--cyan)',
            }}
          >
            Auctions
          </span>
        </span>
      </Link>
    </div>
  </header>
);

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <HomeBar />
      {children}
    </>
  );
}
