// Dev-only QR helper — renders the Expo Go connection URL as a scannable
// QR. Open this on the laptop, point your phone's camera (iOS) or the
// Expo Go in-app scanner (Android) at the screen.
//
// The QR encodes the Expo dev URL on the laptop's LAN IP. If your IP
// changes (DHCP refresh, switching networks), update the EXPO_URL below.

const EXPO_URL = 'exp://192.168.0.17:8081';
const QR_SRC = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${encodeURIComponent(EXPO_URL)}&margin=12&bgcolor=13161e&color=22c55e`;

export default function QrPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 520 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.6,
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 16,
          }}
        >
          Bidder app · Expo Go
        </div>
        <h1
          style={{
            fontSize: '2rem',
            margin: '0 0 1.5rem',
            fontWeight: 900,
            letterSpacing: -0.5,
          }}
        >
          Scan to preview
        </h1>
        <div
          style={{
            display: 'inline-block',
            padding: 16,
            background: 'var(--bg-elev)',
            borderRadius: 16,
            border: '1px solid var(--border)',
          }}
        >
          {/* Dev-only QR helper — plain <img> is fine; this page is gated. */}
          <img
            src={QR_SRC}
            alt={`QR code for ${EXPO_URL}`}
            width={420}
            height={420}
            style={{ display: 'block', borderRadius: 8 }}
          />
        </div>
        <div
          style={{
            marginTop: 20,
            color: 'var(--fg-muted)',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Open Expo Go on your phone (same Wi-Fi) and scan, or paste{' '}
          <code
            style={{
              color: 'var(--accent)',
              background: 'var(--bg-elev)',
              padding: '2px 6px',
              borderRadius: 4,
              fontWeight: 700,
            }}
          >
            {EXPO_URL}
          </code>{' '}
          into the &ldquo;Enter URL manually&rdquo; field.
        </div>
        <div
          style={{
            marginTop: 12,
            color: 'var(--fg-dim)',
            fontSize: 12,
          }}
        >
          iOS: scan with the Camera app, then tap the Expo Go banner. · Android: use the
          in-app scanner inside Expo Go.
        </div>
      </div>
    </main>
  );
}
