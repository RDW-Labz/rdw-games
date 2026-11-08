'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import type { BidIncrementTier } from '@auction-platform/shared';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import {
  BidIncrementScheduleEditor,
  parseDrafts,
  tiersToDrafts,
  type TierDraft,
} from '@/components/BidIncrementScheduleEditor';
import { saveSettings } from './actions';

type Operator = {
  id: string;
  slug: string;
  business_name: string;
  legal_name: string | null;
  contact_email: string;
  contact_phone: string | null;
  logo_url: string | null;
  brand_color: string | null;
  default_buyer_premium_bps: number;
  default_soft_close_minutes: number;
  bid_increment_schedule: BidIncrementTier[] | null;
};

export function SettingsForm({ operator, canEdit }: { operator: Operator; canEdit: boolean }) {
  const router = useRouter();
  const supabase = getSupabaseBrowser();

  const [businessName, setBusinessName] = useState(operator.business_name);
  const [legalName, setLegalName] = useState(operator.legal_name ?? '');
  const [contactEmail, setContactEmail] = useState(operator.contact_email);
  const [contactPhone, setContactPhone] = useState(operator.contact_phone ?? '');
  const [brandColor, setBrandColor] = useState(operator.brand_color ?? '#4f8cff');
  const [logoUrl, setLogoUrl] = useState(operator.logo_url);
  const [premiumBps, setPremiumBps] = useState(String(operator.default_buyer_premium_bps));
  const [softClose, setSoftClose] = useState(String(operator.default_soft_close_minutes));
  // BID-3: configurable increment ladder (empty = legacy ladder).
  const [incrementDrafts, setIncrementDrafts] = useState<TierDraft[]>(
    tiersToDrafts(operator.bid_increment_schedule),
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function onLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
      const path = `${operator.id}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('operator-logos')
        .upload(path, file, { cacheControl: '31536000', upsert: false });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from('operator-logos').getPublicUrl(path);
      setLogoUrl(data.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // BID-3: validate the increment ladder client-side (the server re-checks).
    // Empty list → null → operator falls back to the legacy ladder.
    const parsedSchedule = parseDrafts(incrementDrafts);
    if (!parsedSchedule.ok) {
      setError(parsedSchedule.error);
      return;
    }

    setSaving(true);
    const result = await saveSettings({
      businessName,
      legalName: legalName || null,
      contactEmail,
      contactPhone: contactPhone || null,
      brandColor: brandColor || null,
      logoUrl,
      defaultBuyerPremiumBps: Number(premiumBps),
      defaultSoftCloseMinutes: Number(softClose),
      bidIncrementSchedule: parsedSchedule.tiers,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavedAt(new Date());
    router.refresh();
  }

  return (
    <form onSubmit={onSave} style={{ display: 'grid', gap: '1.25rem', maxWidth: 720 }}>
      <section>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Business</h2>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Field label="Business name">
            <input
              style={inputStyle}
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              required
              disabled={!canEdit}
            />
          </Field>
          <Field label="Legal name (optional)">
            <input
              style={inputStyle}
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              disabled={!canEdit}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <Field label="Contact email">
              <input
                type="email"
                style={inputStyle}
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
                disabled={!canEdit}
              />
            </Field>
            <Field label="Contact phone (optional)">
              <input
                style={inputStyle}
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                disabled={!canEdit}
              />
            </Field>
          </div>
          <Field label="Slug (URL-safe handle)" hint="Locked — contact support to change.">
            <input style={inputStyle} value={operator.slug} disabled />
          </Field>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Branding</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0 }}>
          Bidders see your logo and brand color next to your lots in the marketplace.
        </p>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 12,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {logoUrl ? (
              <Image
                src={logoUrl}
                alt="Logo"
                width={96}
                height={96}
                style={{ objectFit: 'contain' }}
              />
            ) : (
              <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>no logo</span>
            )}
          </div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label style={{ ...secondaryButtonStyle, cursor: canEdit ? 'pointer' : 'default' }}>
              {logoUrl ? 'Replace logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                onChange={onLogoUpload}
                disabled={!canEdit || uploading}
                style={{ display: 'none' }}
              />
            </label>
            {uploading && <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Uploading…</span>}
            {logoUrl && canEdit && (
              <button
                type="button"
                onClick={() => setLogoUrl(null)}
                style={{ ...secondaryButtonStyle, color: 'var(--danger)' }}
              >
                Remove logo
              </button>
            )}
          </div>
        </div>
        <Field label="Brand color">
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              disabled={!canEdit}
              style={{ width: 56, height: 40, border: 'none', background: 'transparent' }}
            />
            <input
              style={{ ...inputStyle, fontFamily: 'monospace', maxWidth: 160 }}
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              disabled={!canEdit}
            />
          </div>
        </Field>
      </section>

      <section>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Auction defaults</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0 }}>
          Pre-filled when creating a new auction. Override per-auction in the auction form.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <Field label="Buyer's premium (bps)" hint="1500 = 15.00%">
            <input
              type="number"
              min="0"
              max="3000"
              style={inputStyle}
              value={premiumBps}
              onChange={(e) => setPremiumBps(e.target.value)}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Soft-close minutes">
            <input
              type="number"
              min="0"
              max="30"
              style={inputStyle}
              value={softClose}
              onChange={(e) => setSoftClose(e.target.value)}
              disabled={!canEdit}
            />
          </Field>
        </div>

        {/* BID-3 — operator default bid-increment ladder. Empty = the built-in
            legacy ladder. Per-auction overrides are set on each auction form. */}
        <div style={{ marginTop: '1rem' }}>
          <BidIncrementScheduleEditor
            drafts={incrementDrafts}
            onChange={setIncrementDrafts}
            disabled={!canEdit}
            label="Bid increment ladder (default)"
            hint="Set the minimum bid increment for each price range. The first tier starts at $0.00. Leave empty to use the standard ladder ($1 up to $25, $2 up to $100, … $50 over $5,000). You can override this per auction."
            emptyHint="Using the standard ladder. Add tiers to set your own increments."
          />
        </div>
      </section>

      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      {savedAt && (
        <div style={{ color: 'var(--success)', fontSize: 13 }}>
          Saved {savedAt.toLocaleTimeString()}
        </div>
      )}
      {canEdit && (
        <div>
          <button type="submit" disabled={saving} style={buttonStyle}>
            {saving ? 'Saving…' : 'Save Business, Branding & Auction Defaults'}
          </button>
        </div>
      )}

    </form>
  );
}
