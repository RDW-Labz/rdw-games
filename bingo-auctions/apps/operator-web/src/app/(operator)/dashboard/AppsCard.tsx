// Apps card — permanent dashboard card listing the three apps in the
// BinGo Auctions ecosystem with install links. Always visible (vs. the
// WelcomeBanner which only shows once). Server component so it can read
// env vars at render time without exposing them to the client.

import Link from 'next/link';

export function AppsCard({
  operatorWebUrl,
  fieldAppUrl,
  bidderAppUrl,
}: {
  operatorWebUrl: string;
  fieldAppUrl: string | null;
  bidderAppUrl: string | null;
}) {
  return (
    <section
      style={{
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div style={{ marginBottom: '0.75rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Apps &amp; links</h2>
        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>
          Share these with your team and your bidders.
        </div>
      </div>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <Row
          label="Operator console"
          who="You + your admins"
          url={operatorWebUrl}
          isLocal
        />
        <Row
          label="Picker app"
          who="Warehouse staff · iOS"
          url={fieldAppUrl}
          fallback="TestFlight link will appear here once builds are submitted to Apple."
        />
        <Row
          label="Bidder app"
          who="Your customers · iOS"
          url={bidderAppUrl}
          fallback="TestFlight link will appear here once builds are submitted to Apple."
        />
      </div>
      <div style={{ marginTop: '0.85rem', fontSize: 12, color: 'var(--fg-muted)' }}>
        New staff? Use <Link href="/staff" style={{ color: 'var(--accent)' }}>Staff → Invite</Link>{' '}
        — the system generates a copy-paste message with everything they need.
      </div>
    </section>
  );
}

function Row({
  label,
  who,
  url,
  fallback,
  isLocal,
}: {
  label: string;
  who: string;
  url: string | null;
  fallback?: string;
  isLocal?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.55rem 0.75rem',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <div style={{ color: 'var(--fg-muted)', fontSize: 11, marginTop: 2 }}>
          {who}
        </div>
      </div>
      {url ? (
        <a
          href={url}
          target={isLocal ? undefined : '_blank'}
          rel={isLocal ? undefined : 'noreferrer'}
          style={{
            padding: '0.35rem 0.75rem',
            background: 'transparent',
            border: '1px solid var(--accent)',
            color: 'var(--accent)',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            fontFamily: 'monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 280,
          }}
        >
          {url.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
          {fallback ?? '—'}
        </span>
      )}
    </div>
  );
}
