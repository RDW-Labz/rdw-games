// SSRF guard for the scrape-url route.
//
// Rejects any URL that could route to internal / private infrastructure:
//   - Non-https schemes (http://, file://, ftp://, etc.)
//   - Literal "localhost"
//   - RFC1918 private ranges: 10/8, 172.16/12, 192.168/16
//   - Loopback: 127/8, ::1
//   - Link-local: 169.254/16
//   - Unspecified: 0.0.0.0
//
// Note: this check operates on the literal hostname in the URL. DNS-rebinding
// after this check is still theoretically possible; the allowed-source
// allowlist in detectSource() provides a second layer (only amazon/ebay/google
// hosts reach the actual fetch).
//
// Exported as a standalone module so it can be unit-tested without importing
// Next.js internals.

export function isSafeScrapeUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();

  if (host === 'localhost') return false;
  if (host === '0.0.0.0') return false;
  if (host === '::1') return false;

  // Dotted-decimal IPv4 ranges
  const ipv4Parts = host.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = ipv4Parts as [number, number, number, number];
    if (a === 10) return false;                        // 10/8
    if (a === 127) return false;                       // 127/8 loopback
    if (a === 169 && b === 254) return false;          // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false;          // 192.168/16
  }

  return true;
}
