'use client';

// Social posting controls for /marketing (0323/0324).
//
// Sits beside the email digest because they are the same job — reaching people
// about lots that are about to close. The difference worth showing plainly is
// audience: the digest reaches bidders who already opted in, this reaches a
// public feed. That is why the OFF state is stated rather than implied, and why
// "Preview" is the prominent action and "Post now" the quiet one.

import { useState, useTransition } from 'react';
import { setSocialPostingEnabled, socialDryRun, socialPostNow } from './actions';

export interface SocialPostRow {
  id: string;
  platform: string;
  status: string;
  message: string | null;
  permalink: string | null;
  error: string | null;
  created_at: string;
}

export function SocialPanel({
  enabled,
  credentialsConfigured,
  recent,
  postedLast7d,
}: {
  enabled: boolean;
  credentialsConfigured: boolean;
  recent: SocialPostRow[];
  postedLast7d: number;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string }>) {
    setNote(null);
    startTransition(async () => setNote(await fn()));
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Social posting</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginTop: 0 }}>
        Publishes closing-soon lots to the Facebook Page. Unlike the digest, this
        reaches a public feed, not just opted-in bidders. Posts are removed
        automatically once their auction ends.
      </p>

      {/* Credentials come first: with them missing, every other control here is
          inert, and saying so beats letting someone click and get a vague error. */}
      {!credentialsConfigured && (
        <div style={banner('#7c2d12', '#fff7ed')}>
          <strong>Meta credentials not configured.</strong> Set{' '}
          <code>META_PAGE_ACCESS_TOKEN</code>, <code>META_PAGE_ID</code> and{' '}
          <code>META_IG_USER_ID</code> in Worker secrets. Nothing can publish until then.
        </div>
      )}

      <div style={banner(enabled ? '#065f46' : '#374151', enabled ? '#ecfdf5' : '#f9fafb')}>
        <strong>{enabled ? 'ON' : 'OFF'}</strong>{' '}
        {enabled
          ? '— the scheduled run publishes to the Page.'
          : '— nothing publishes. Takedown of already-published posts still runs.'}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => setSocialPostingEnabled(!enabled))}
          style={btn(enabled ? 'danger' : 'primary')}
        >
          {enabled ? 'Turn OFF' : 'Turn ON'}
        </button>

        {/* Preview is the primary action deliberately: it is the only way to
            see the copy and the lot selection BEFORE anything is public. */}
        <button type="button" disabled={pending} onClick={() => run(socialDryRun)} style={btn('primary')}>
          Preview a run (publishes nothing)
        </button>

        <button type="button" disabled={pending || !enabled} onClick={() => run(socialPostNow)} style={btn('ghost')}>
          Post now
        </button>
      </div>

      {note && (
        <div style={banner(note.ok ? '#065f46' : '#991b1b', note.ok ? '#ecfdf5' : '#fef2f2')}>
          {note.message}
        </div>
      )}

      <p style={{ color: '#6b7280', fontSize: 13, marginTop: 12 }}>
        {postedLast7d} post{postedLast7d === 1 ? '' : 's'} published in the last 7 days.
      </p>

      {recent.length > 0 && (
        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                <th style={th}>When</th><th style={th}>Platform</th>
                <th style={th}>Status</th><th style={th}>Copy</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={td}>{r.platform === 'instagram' ? 'Instagram' : 'Facebook'}</td>
                  <td style={td}>
                    {r.permalink ? (
                      <a href={r.permalink} target="_blank" rel="noreferrer">{r.status}</a>
                    ) : (
                      r.status
                    )}
                    {/* The error is the useful part of a failed row — surfacing
                        it here is what stops a silent failure becoming a
                        week-long "why is nothing posting?" */}
                    {r.error && <div style={{ color: '#991b1b' }}>{r.error}</div>}
                  </td>
                  <td style={{ ...td, whiteSpace: 'pre-wrap', maxWidth: 420 }}>{r.message}</td>
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

function banner(color: string, bg: string): React.CSSProperties {
  return {
    marginTop: 12, padding: '10px 12px', borderRadius: 8,
    background: bg, color, border: `1px solid ${color}22`, fontSize: 14,
  };
}

function btn(kind: 'primary' | 'danger' | 'ghost'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  };
  if (kind === 'primary') return { ...base, background: '#111827', color: '#fff', border: '1px solid #111827' };
  if (kind === 'danger') return { ...base, background: '#fff', color: '#991b1b', border: '1px solid #991b1b' };
  return { ...base, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
}
