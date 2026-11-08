// Crashes and silent exits, shown beside the typed reports.
//
// These arrive without anybody filing them: lib/crash-reporter.ts posts JS
// throws, lib/session-watchdog.ts posts processes that vanished without one.
// They belong on this page rather than a separate ops screen because they
// answer the question the typed reports raise — a staff member writes "it backed me out
// again" and the row underneath says which screen, which build, and whether
// she was mid-lot.
//
// is_fatal separates them: true = a JS error was thrown and caught; false = the
// watchdog inferred the death after the fact from a stale session mark. The
// second kind has no stack by definition, so the table shows the message and
// the screen and does not pretend otherwise.

export interface CrashRecord {
  id: string;
  created_at: string;
  app: string;
  platform: string;
  app_version: string | null;
  ota_update: string | null;
  message: string;
  screen: string | null;
  is_fatal: boolean;
}

export function SilentExits({ rows }: { rows: CrashRecord[] }) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>
        Crashes &amp; silent exits ({rows.length})
      </h2>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0 }}>
        Reported automatically by the apps — nobody has to file these. A{' '}
        <strong>silent exit</strong> is the process disappearing with no JS error
        and no crash log: the &ldquo;it backs me out and I start over&rdquo; case.
      </p>

      {rows.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>
          Nothing reported in the last 7 days.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                <th style={th}>When</th>
                <th style={th}>Kind</th>
                <th style={th}>Screen</th>
                <th style={th}>Build</th>
                <th style={th}>What happened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={td}>{r.is_fatal ? 'JS crash' : 'Silent exit'}</td>
                  <td style={td}>{r.screen ?? '—'}</td>
                  <td style={td}>
                    {r.app_version ?? '—'}
                    <div style={{ color: 'var(--fg-muted)' }}>
                      {r.platform}
                      {r.ota_update && r.ota_update !== 'embedded'
                        ? ` · ota ${r.ota_update.slice(0, 8)}`
                        : ' · embedded'}
                    </div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'pre-wrap' }}>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };
