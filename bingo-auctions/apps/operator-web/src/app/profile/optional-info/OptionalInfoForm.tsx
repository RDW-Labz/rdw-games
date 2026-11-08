// Client form for /profile/optional-info. Writes only through
// set_my_optional_profile() (migration 0448, SECURITY DEFINER) — there is no
// direct column grant for sms_consent_at / heard_about / heard_about_other,
// by design (see that migration's header).

'use client';

import { useMemo, useState } from 'react';
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX_LEN,
  SMS_CONSENT_ENABLED,
  SMS_CONSENT_TEXT,
  SMS_CONSENT_TEXT_VERSION,
  isValidHeardAbout,
} from '@auction-platform/shared';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return `+${digits}`;
}

export function OptionalInfoForm({
  initialPhone,
  consentedAt,
  initialHeardAbout,
  initialHeardAboutOther,
}: {
  initialPhone: string;
  consentedAt: string | null;
  initialHeardAbout: string | null;
  initialHeardAboutOther: string;
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [phone, setPhone] = useState(initialPhone);
  const [smsConsent, setSmsConsent] = useState(false);
  const [heardAbout, setHeardAbout] = useState<string | null>(initialHeardAbout);
  const [heardAboutOther, setHeardAboutOther] = useState(initialHeardAboutOther);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    if (heardAbout != null && !isValidHeardAbout(heardAbout)) return; // picker only offers valid values
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error: rpcErr } = await supabase.rpc('set_my_optional_profile', {
      // Held (SMS_CONSENT_ENABLED): NULL leaves the phone on file alone.
      p_phone: SMS_CONSENT_ENABLED && phone.trim() ? normalizePhone(phone) : null,
      // A timestamped consent is a one-time legal record — never re-sent or
      // revoked by this form once it exists (same rule as the bidder app;
      // see OptionalProfileFields.tsx's consentedAt note there).
      p_sms_consent: !SMS_CONSENT_ENABLED || consentedAt ? false : smsConsent,
      p_sms_consent_text_version: SMS_CONSENT_ENABLED && !consentedAt && smsConsent ? SMS_CONSENT_TEXT_VERSION : null,
      p_heard_about: heardAbout,
      p_heard_about_other: heardAbout === 'other' ? heardAboutOther.slice(0, HEARD_ABOUT_OTHER_MAX_LEN) : null,
    });
    setSaving(false);
    if (rpcErr) {
      setError('Could not save. Check your connection and try again.');
      return;
    }
    setSaved(true);
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      {/* Phone + text consent: held until the consent wording is approved. */}
      {SMS_CONSENT_ENABLED && (
      <div>
        <label style={{ fontSize: 12, color: 'var(--fg-dim)', textTransform: 'uppercase' }}>
          Phone
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 (555) 555-5555"
          autoComplete="tel"
          style={{
            marginTop: 4,
            width: '100%',
            padding: '0.85rem',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--fg)',
            fontSize: 15,
          }}
        />
      </div>
      )}

      {!SMS_CONSENT_ENABLED ? null : consentedAt ? (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.85rem',
          }}
        >
          <div style={{ color: 'var(--success, #34d39a)', fontSize: 13, fontWeight: 700 }}>
            Texting consent recorded {new Date(consentedAt).toLocaleDateString()}
          </div>
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>
            To stop texts, turn off SMS under notification preferences.
          </div>
        </div>
      ) : (
        <label
          style={{
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
            opacity: phone.trim() ? 1 : 0.5,
          }}
        >
          <input
            type="checkbox"
            checked={smsConsent}
            disabled={!phone.trim()}
            onChange={(e) => setSmsConsent(e.target.checked)}
            style={{ marginTop: 3 }}
            aria-label="Agree to receive text messages"
          />
          <span>{SMS_CONSENT_TEXT}</span>
        </label>
      )}

      <div>
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', textTransform: 'uppercase', marginBottom: 6 }}>
          How did you hear about us?
        </div>
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {HEARD_ABOUT_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.5rem 0.6rem',
                borderRadius: 8,
                border: `1px solid ${heardAbout === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="heard-about"
                value={opt.value}
                checked={heardAbout === opt.value}
                onChange={() => setHeardAbout(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
        {heardAbout === 'other' && (
          <input
            type="text"
            value={heardAboutOther}
            onChange={(e) => setHeardAboutOther(e.target.value.slice(0, HEARD_ABOUT_OTHER_MAX_LEN))}
            maxLength={HEARD_ABOUT_OTHER_MAX_LEN}
            placeholder="Tell us more"
            style={{
              marginTop: 8,
              width: '100%',
              padding: '0.65rem',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontSize: 14,
            }}
          />
        )}
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      {saved && <div style={{ color: 'var(--success, #34d39a)', fontSize: 13 }}>Saved.</div>}

      <button
        type="button"
        onClick={() => void onSave()}
        disabled={saving}
        className="btn-primary"
        style={{ padding: '0.85rem', opacity: saving ? 0.7 : 1 }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
