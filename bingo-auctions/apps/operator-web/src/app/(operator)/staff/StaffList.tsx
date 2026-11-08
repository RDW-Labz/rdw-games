'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { DataTable, type Column } from '@/components/console';

type Staff = {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'manager' | 'picker' | 'lead';
  accepted_at: string | null;
  invited_at: string;
  user_id: string;
};

// Shape of the success response from /api/staff/invite — used to render
// the one-screen credentials card after a successful invite. Direct-
// password flow includes the temp password (shown ONCE, never persisted);
// magic-link flow doesn't.
type InviteSuccess = {
  ok: true;
  email: string;
  displayName: string | null;
  role: Staff['role'];
  operatorWebUrl: string;
  testflightFieldUrl: string | null;
  testflightBidderUrl: string | null;
  mode: 'direct_password' | 'magic_link' | 'reused';
  initialPassword?: string;
  credentialsDisplay?: {
    shownOnce: boolean;
    message: string;
  };
};

const ROLE_HINTS: Record<Staff['role'], string> = {
  admin: 'Full access, billing, staff management.',
  manager: 'Catalog, auctions, pickups, disputes. No billing or staff.',
  picker: 'Picker app: stage lots and confirm pickups. No web console.',
  lead: 'Checkout + in-window refunds. No catalog, settings, or staff management.',
};

// Role badge colors, tokens only (was rgba(var(--accent-rgb…)), darkorange).
// admin = accent (privileged), manager/lead = warning (elevated), picker =
// neutral (field-only).
const ROLE_BADGE: Record<Staff['role'], { bg: string; fg: string }> = {
  admin: { bg: 'var(--accent-dim)', fg: 'var(--accent)' },
  manager: { bg: 'var(--warning-dim)', fg: 'var(--warning)' },
  lead: { bg: 'var(--warning-dim)', fg: 'var(--warning)' },
  picker: { bg: 'var(--bg-elev)', fg: 'var(--fg-muted)' },
};

// Password generation moved server-side as part of LAUNCH_PLAN §1.7.
// Pre-fix: this file generated a temp password in the browser, POSTed
// the plaintext to /api/staff/invite, and the server echoed it back.
// That meant the password lived in: (a) browser memory, (b) the outgoing
// POST body, (c) the response body. Multiple opportunities to land in
// browser-extension logs or a screenshot pinned in 1Password.
// Post-fix: the admin opts in via `generateInitialPassword: true` on the
// POST; the server generates the password, hashes it via Supabase Auth,
// and returns the plaintext in the success card ONCE. Sentry beforeSend
// strips `password` keys from any event payload.

// Build a single text block the admin can paste into Slack / SMS /
// email to the new tester. Includes only the fields that are set —
// magic-link invites omit the password row, missing TestFlight URLs
// omit those rows, etc.
function buildShareText(s: InviteSuccess): string {
  const lines: string[] = [];
  lines.push(`Hey${s.displayName ? ` ${s.displayName}` : ''} — you're set up as ${s.role} on BinGo Auctions. Here's everything you need:`);
  lines.push('');
  lines.push(`Sign-in URL: ${s.operatorWebUrl}`);
  lines.push(`Email:       ${s.email}`);
  if (s.mode === 'direct_password' && s.initialPassword) {
    lines.push(`Password:    ${s.initialPassword}   (change it under Account → Password once you're in)`);
  } else if (s.mode === 'magic_link') {
    lines.push(`Password:    set it from the Supabase invite email I just sent you`);
  }
  if (s.testflightFieldUrl) {
    lines.push('');
    lines.push(`Picker app (iOS): ${s.testflightFieldUrl}`);
    lines.push('  Install the TestFlight app first if you don\'t have it.');
  }
  if (s.testflightBidderUrl) {
    lines.push(`Bidder app (iOS): ${s.testflightBidderUrl}`);
  }
  return lines.join('\n');
}

export function StaffList({
  staff,
  isAdmin,
  currentUserId,
}: {
  staff: Staff[];
  isAdmin: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Staff['role']>('picker');
  const [usePassword, setUsePassword] = useState(true);
  const [invitePassword, setInvitePassword] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<InviteSuccess | null>(null);
  const [copied, setCopied] = useState(false);

  async function invite() {
    setError(null);
    setInviting(true);
    // §1.7: prefer server-side password generation. The admin can still
    // override by typing a password (e.g. when the new tester has a
    // preferred string), but if the input is empty we ask the server to
    // generate one. Never call the old browser-side generatePassword().
    const adminTyped = usePassword ? invitePassword.trim() : '';
    const res = await fetch('/api/staff/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: inviteEmail,
        role: inviteRole,
        displayName: inviteName || undefined,
        // Flow B options. Either send an explicit initialPassword OR
        // generateInitialPassword=true — never both, never an empty
        // string (which would trip zod min(12) and bounce to magic-link).
        ...(usePassword && adminTyped.length >= 12
          ? { initialPassword: adminTyped }
          : usePassword
            ? { generateInitialPassword: true }
            : {}),
      }),
    });
    setInviting(false);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.error ?? `Server returned ${res.status}`);
      return;
    }
    const payload = (await res.json()) as InviteSuccess;
    setSuccess(payload);
    setShowInvite(false);
    setInviteEmail('');
    setInviteName('');
    setInvitePassword('');
    router.refresh();
  }

  function copyShare() {
    if (!success) return;
    const text = buildShareText(success);
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Copy ONLY the temp password — no surrounding text. Lets the admin
  // paste straight into a password field (their own browser-extension
  // manager, a Bitwarden vault, the staff member's chat window, etc.)
  // without having to clean out the multi-line share-text wrapper.
  // Launch-week field bug: admins were copying the full share text into
  // Slack and the recipient was selecting only part of the password line.
  const [copiedPwd, setCopiedPwd] = useState(false);
  function copyPasswordOnly() {
    if (!success?.initialPassword) return;
    void navigator.clipboard.writeText(success.initialPassword).then(() => {
      setCopiedPwd(true);
      setTimeout(() => setCopiedPwd(false), 1500);
    });
  }

  async function changeRole(s: Staff, role: Staff['role']) {
    if (s.role === role) return;
    const res = await fetch(`/api/staff/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error ?? 'Update failed');
      return;
    }
    router.refresh();
  }

  async function remove(s: Staff) {
    if (!confirm(`Remove ${s.email} from this operator?`)) return;
    const res = await fetch(`/api/staff/${s.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error ?? 'Remove failed');
      return;
    }
    router.refresh();
  }

  const columns: Column<Staff>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (s) => (
        <div>
          <div style={{ fontWeight: 500 }}>{s.display_name ?? s.email}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{s.email}</div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 200,
      cell: (s) =>
        isAdmin && s.user_id !== currentUserId ? (
          <select
            value={s.role}
            onChange={(e) => changeRole(s, e.target.value as Staff['role'])}
            style={{ ...inputStyle, padding: '0.3rem' }}
          >
            <option value="picker">Picker</option>
            <option value="lead">Lead / Key holder</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        ) : (
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 3,
              background: ROLE_BADGE[s.role].bg,
              color: ROLE_BADGE[s.role].fg,
              textTransform: 'capitalize',
            }}
          >
            {s.role}
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 200,
      cell: (s) => (
        <span style={{ fontSize: 13 }}>
          {s.accepted_at
            ? `Active since ${new Date(s.accepted_at).toLocaleDateString()}`
            : `Invited ${new Date(s.invited_at).toLocaleDateString()}`}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      width: 120,
      cell: (s) =>
        isAdmin && s.user_id !== currentUserId ? (
          <button
            onClick={() => remove(s)}
            style={{ ...secondaryButtonStyle, color: 'var(--danger)' }}
          >
            Remove
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      {/* Success card. Renders only after a successful invite — shows
          every credential + link in one place so the admin can copy it
          all into a single Slack/SMS message and be done. */}
      {success && (
        <div
          style={{
            padding: '1rem 1.25rem',
            marginBottom: '1.5rem',
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0, color: 'var(--accent)' }}>
              {success.mode === 'magic_link'
                ? 'Magic-link sent'
                : success.mode === 'reused'
                  ? 'Added to operator'
                  : 'Credentials ready'}
            </h3>
            <button
              onClick={() => setSuccess(null)}
              style={{ ...secondaryButtonStyle, padding: '4px 10px', fontSize: 12 }}
            >
              Dismiss
            </button>
          </div>
          {success.mode === 'magic_link' && (
            <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--fg-muted)' }}>
              Supabase emailed <strong style={{ color: 'var(--fg)' }}>{success.email}</strong> a magic
              link. They click it, set a password, sign in. If it doesn&apos;t arrive in a few
              minutes, check spam — or run the invite again with a temp password.
            </p>
          )}
          {success.mode === 'direct_password' && (
            <>
              <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--fg-muted)' }}>
                No email round-trip. Share these credentials with{' '}
                <strong style={{ color: 'var(--fg)' }}>
                  {success.displayName ?? success.email}
                </strong>{' '}
                directly. They will be forced to rotate the password on first sign-in.
              </p>
              <p
                style={{
                  margin: '8px 0 4px',
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'var(--danger-dim, #5c2222)',
                  color: 'var(--danger, #ffd1d1)',
                  borderRadius: 4,
                  border: '1px solid var(--danger, #ff8080)',
                }}
              >
                Copy this now — the temp password is shown ONCE. Dismissing this card
                or refreshing the page wipes it. We will not retrieve it again; the
                only recovery path is resetting the password.
              </p>
            </>
          )}
          {success.mode === 'reused' && (
            <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--fg-muted)' }}>
              <strong style={{ color: 'var(--fg)' }}>{success.email}</strong> already had a Supabase
              account (probably a bidder signup). They&apos;ll keep their existing password and now
              have <strong style={{ color: 'var(--fg)' }}>{success.role}</strong> access on the
              operator side.
            </p>
          )}

          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              color: 'var(--fg)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              overflow: 'auto',
            }}
          >
            {buildShareText(success)}
          </pre>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {success.mode === 'direct_password' && success.initialPassword && (
              <button
                onClick={copyPasswordOnly}
                style={{
                  ...buttonStyle,
                  padding: '6px 14px',
                  fontSize: 13,
                  background: 'var(--danger, #c84040)',
                }}
                title="Copy ONLY the temp password — no surrounding text. Paste straight into a password field or DM."
              >
                {copiedPwd ? '✓ Password copied' : 'Copy password only'}
              </button>
            )}
            <button
              onClick={copyShare}
              style={{
                ...buttonStyle,
                padding: '6px 14px',
                fontSize: 13,
              }}
            >
              {copied ? '✓ Copied' : 'Copy share text'}
            </button>
            {(success.testflightFieldUrl || success.testflightBidderUrl) ? null : (
              <span style={{ fontSize: 12, color: 'var(--fg-muted)', alignSelf: 'center' }}>
                TestFlight install links will appear here once builds are submitted to Apple.
              </span>
            )}
          </div>
        </div>
      )}

      {isAdmin && (
        <div style={{ marginBottom: '1.5rem' }}>
          {showInvite ? (
            <div
              style={{
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                display: 'grid',
                gap: '0.75rem',
                maxWidth: 540,
              }}
            >
              <h3 style={{ marginTop: 0 }}>Invite staff</h3>
              <Field label="Email">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  style={inputStyle}
                  required
                />
              </Field>
              <Field label="Display name (optional)">
                <input
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Role" hint={ROLE_HINTS[inviteRole]}>
                <select
                  style={inputStyle}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Staff['role'])}
                >
                  <option value="picker">Picker</option>
                  <option value="lead">Lead / Key holder</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </Field>

              {/* Direct-password toggle. Defaults ON because it skips the
                  email round-trip and is materially faster for the
                  tester. Magic-link is still there as a fallback (e.g.
                  when admin can't share a temp password securely). */}
              <Field
                label="How they sign in"
                hint={
                  usePassword
                    ? 'No email sent. Share the temp password with them directly. They can change it after first sign-in.'
                    : 'Supabase emails a magic link. They click → set their own password → sign in.'
                }
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="radio"
                      checked={usePassword}
                      onChange={() => setUsePassword(true)}
                    />
                    Set temp password (recommended)
                  </label>
                  <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="radio"
                      checked={!usePassword}
                      onChange={() => setUsePassword(false)}
                    />
                    Email a magic link
                  </label>
                </div>
              </Field>

              {usePassword && (
                <Field
                  label="Temp password (optional)"
                  hint="Min 12 chars. Leave blank to have the server generate one (recommended). The plaintext is shown ONCE on the next screen — copy it then or you'll need to reset the password later."
                >
                  <input
                    type="text"
                    value={invitePassword}
                    onChange={(e) => setInvitePassword(e.target.value)}
                    placeholder="(server-generated if blank)"
                    style={{ ...inputStyle, fontFamily: 'ui-monospace, Menlo, monospace' }}
                  />
                </Field>
              )}

              {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={invite} disabled={inviting || !inviteEmail} style={buttonStyle}>
                  {inviting
                    ? 'Working…'
                    : usePassword
                      ? 'Create + show credentials'
                      : 'Send magic-link email'}
                </button>
                <button onClick={() => setShowInvite(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowInvite(true)} style={buttonStyle}>
              Invite staff
            </button>
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={staff}
        rowKey={(s) => s.id}
        empty="No staff yet."
      />
    </div>
  );
}
