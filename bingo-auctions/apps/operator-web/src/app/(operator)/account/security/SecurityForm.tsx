'use client';

// Client form for /account/security. Three sub-flows in one component:
//
//   1. List existing factors with an "Unenroll" button (TOTP only — phone
//      factors aren't used yet).
//   2. "Enroll a new authenticator" — calls supabase.auth.mfa.enroll(),
//      renders the QR + secret, then verifies the 6-digit code via
//      challenge() + verify().
//   3. After successful verification the factor flips from `unverified`
//      to `verified`. The session is NOT automatically elevated to AAL2
//      on enroll — the user still needs to go through /step-up next time
//      they hit a sensitive page (that's intentional; enrolling the
//      factor is a separate ceremony from authenticating with it).
//
// Why combine list + enroll + unenroll in one component? Mutations from
// any of the three need to refresh the same factors-list state, and the
// three flows are presented as one page in the UX. A single client
// component owning the factors state is the simplest model.
//
// Recovery copy lives at the bottom of the form so an admin who's about
// to enroll is reminded what happens if they lose their device.

import { useEffect, useMemo, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

type FactorSummary = {
  id: string;
  friendly_name: string | null;
  factor_type: string;
  status: string;
  created_at: string;
};

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
  width: '100%',
};

const buttonStyle: React.CSSProperties = {
  padding: '0.6rem 1.2rem',
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 600,
};

const dangerButtonStyle: React.CSSProperties = {
  padding: '0.4rem 0.85rem',
  background: 'transparent',
  color: 'var(--danger, #ff6060)',
  border: '1px solid var(--danger, #ff6060)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};

const sectionStyle: React.CSSProperties = {
  padding: '1rem 1.25rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  marginBottom: '1.5rem',
};

export function SecurityForm({
  isAdmin,
  initialFactors,
}: {
  isAdmin: boolean;
  initialFactors: FactorSummary[];
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [factors, setFactors] = useState<FactorSummary[]>(initialFactors);

  // ── Enrollment state ──────────────────────────────────────────────────
  // null  → not enrolling. Click "Add a new authenticator" to start.
  // not-null → enrollment in progress; supabase has issued a QR + secret.
  const [pendingEnroll, setPendingEnroll] = useState<{
    factorId: string;
    qrCode: string;   // SVG data URL
    secret: string;   // plain-text otpauth secret (for manual entry)
    uri: string;      // raw otpauth:// URI (for advanced users)
  } | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollStarting, setEnrollStarting] = useState(false);

  const verifiedTotpFactors = factors.filter(
    (f) => f.factor_type === 'totp' && f.status === 'verified',
  );

  async function refreshFactors(): Promise<void> {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      // Non-fatal — keep the existing list but log to console for ops debugging.
      console.warn('listFactors failed', error.message);
      return;
    }
    setFactors(
      (data?.all ?? []).map((f) => ({
        id: f.id,
        friendly_name: f.friendly_name ?? null,
        factor_type: f.factor_type,
        status: f.status,
        created_at: f.created_at,
      })),
    );
  }

  async function startEnrollment(): Promise<void> {
    setEnrollError(null);
    setEnrollStarting(true);
    // Supabase auto-generates friendly_name conflicts if you reuse the
    // same name on a re-enrollment after unenroll. Tag the timestamp so
    // each enrollment is uniquely named server-side. Visible to the user
    // only on the listFactors output (which trims to "Authenticator app"
    // visually below).
    const friendlyName = `Authenticator app (${new Date()
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ')})`;
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName,
    });
    setEnrollStarting(false);
    if (error) {
      setEnrollError(error.message);
      return;
    }
    if (!data) {
      setEnrollError('Unexpected enrollment response.');
      return;
    }
    // The overload `enroll({ factorType: 'totp', … })` is typed to return
    // AuthMFAEnrollTOTPResponse, so `data.totp` is guaranteed by the
    // type system. No runtime branch needed beyond the null-check above.
    setPendingEnroll({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
    setEnrollCode('');
  }

  async function cancelEnrollment(): Promise<void> {
    if (!pendingEnroll) return;
    // Best-effort: clean up the unverified factor on the server side so it
    // doesn't pile up in listFactors. Errors here are non-fatal — the
    // factor will simply remain in `unverified` state until it expires.
    await supabase.auth.mfa.unenroll({ factorId: pendingEnroll.factorId });
    setPendingEnroll(null);
    setEnrollCode('');
    setEnrollError(null);
    await refreshFactors();
  }

  async function verifyEnrollment(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!pendingEnroll) return;
    setEnrollError(null);
    const code = enrollCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setEnrollError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setEnrolling(true);
    try {
      // Two-step ceremony: challenge() generates a server-side challenge
      // tied to this factor, then verify() consumes the challenge with the
      // user-typed code. (challengeAndVerify() exists too but is documented
      // as combining both — we keep them split here so the failure modes
      // surface clearly, e.g. "challenge expired" vs. "wrong code".)
      const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId: pendingEnroll.factorId,
      });
      if (challengeErr || !challenge) {
        setEnrollError(challengeErr?.message ?? 'Could not start verification.');
        setEnrolling(false);
        return;
      }
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId: pendingEnroll.factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyErr) {
        setEnrollError(verifyErr.message);
        setEnrolling(false);
        setEnrollCode(''); // clear so a typo doesn't linger
        return;
      }
      // Success — factor is verified. Drop the QR widget and refresh
      // the factor list.
      setPendingEnroll(null);
      setEnrollCode('');
      await refreshFactors();
    } finally {
      setEnrolling(false);
    }
  }

  async function unenrollFactor(factorId: string): Promise<void> {
    const confirmed = window.confirm(
      isAdmin
        ? 'Remove this authenticator? You will be required to set up a new one before you can access staff management, billing, account settings, or payouts.'
        : 'Remove this authenticator?',
    );
    if (!confirmed) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) {
      window.alert(`Could not remove factor: ${error.message}`);
      return;
    }
    await refreshFactors();
  }

  // Refresh once on mount to ensure we're in sync with the server (the
  // server-rendered snapshot can be stale if another tab made changes).
  useEffect(() => {
    refreshFactors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* ── Existing factors ────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Your authenticators</h2>
        {verifiedTotpFactors.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 14 }}>
            You don&apos;t have any authenticators set up yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
            {verifiedTotpFactors.map((f) => (
              <li
                key={f.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '0.6rem 0.85rem',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 14,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    {f.friendly_name ?? 'Authenticator app'}
                  </div>
                  <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                    Added {new Date(f.created_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => unenrollFactor(f.id)}
                  style={dangerButtonStyle}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Enroll a new factor ─────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          {verifiedTotpFactors.length === 0
            ? 'Set up an authenticator'
            : 'Add another authenticator'}
        </h2>

        {!pendingEnroll && (
          <>
            <p style={{ margin: '0 0 1rem 0', color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.6 }}>
              Use an app like 1Password, Google Authenticator, Authy, or any
              other TOTP-compatible authenticator. You&apos;ll scan a QR code
              and enter a 6-digit code to confirm it works.
            </p>
            {enrollError && (
              <div style={{ color: 'var(--danger, #ff6060)', fontSize: 13, marginBottom: '0.75rem' }}>
                {enrollError}
              </div>
            )}
            <button
              type="button"
              onClick={startEnrollment}
              disabled={enrollStarting}
              style={{ ...buttonStyle, opacity: enrollStarting ? 0.5 : 1 }}
            >
              {enrollStarting ? 'Loading…' : 'Add a new authenticator'}
            </button>
          </>
        )}

        {pendingEnroll && (
          <div>
            <p style={{ margin: '0 0 0.75rem 0', fontSize: 14, color: 'var(--fg-muted)' }}>
              1. Scan this QR code with your authenticator app:
            </p>
            <div
              style={{
                display: 'inline-block',
                background: '#fff',
                padding: '0.5rem',
                borderRadius: 4,
                marginBottom: '1rem',
              }}
            >
              {/* qr_code is a data URL — img src is the right element. */}
              {/* plain <img> — opennextjs has known edge cases with <Image> over CF resizing */}
              <img
                src={pendingEnroll.qrCode}
                alt="TOTP QR code"
                style={{ width: 200, height: 200, display: 'block' }}
              />
            </div>
            <p style={{ margin: '0 0 0.4rem 0', fontSize: 13, color: 'var(--fg-muted)' }}>
              Can&apos;t scan? Type this secret into your app instead:
            </p>
            <code
              style={{
                display: 'inline-block',
                padding: '0.4rem 0.6rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontFamily: 'monospace',
                fontSize: 13,
                marginBottom: '1.25rem',
                userSelect: 'all',
                wordBreak: 'break-all',
              }}
            >
              {pendingEnroll.secret}
            </code>

            <form onSubmit={verifyEnrollment} style={{ display: 'grid', gap: '0.75rem' }}>
              <label htmlFor="totp-code" style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
                2. Enter the 6-digit code from your app:
              </label>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
                style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.3em' }}
                autoFocus
              />
              {enrollError && (
                <div style={{ color: 'var(--danger, #ff6060)', fontSize: 13 }}>
                  {enrollError}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="submit"
                  disabled={enrolling || enrollCode.length !== 6}
                  style={{
                    ...buttonStyle,
                    opacity: enrolling || enrollCode.length !== 6 ? 0.5 : 1,
                  }}
                >
                  {enrolling ? 'Verifying…' : 'Verify and enable'}
                </button>
                <button
                  type="button"
                  onClick={cancelEnrollment}
                  disabled={enrolling}
                  style={{
                    padding: '0.6rem 1.2rem',
                    background: 'transparent',
                    color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </section>

      {/* ── Recovery / lockout warning ──────────────────────────────────── */}
      {isAdmin && (
        <section
          style={{
            ...sectionStyle,
            background: 'rgba(255, 165, 0, 0.06)',
            border: '1px solid rgba(255, 165, 0, 0.3)',
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 14, color: 'orange' }}>
            If you lose your authenticator
          </h2>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.6 }}>
            There&apos;s no self-service recovery. If you lose access to your
            phone or authenticator app, email{' '}
            <a href="mailto:legal@bingoauctions.com">legal@bingoauctions.com</a> from a
            verified address. The platform team will verify your identity and
            remove the factor manually. To avoid getting locked out, consider
            adding more than one authenticator (e.g. one on your phone, one
            in a password manager like 1Password).
          </p>
        </section>
      )}
    </div>
  );
}
