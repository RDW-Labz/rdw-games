'use client';

// Client form for /settings/policies. Edits per-operator storefront-display
// policy fields: buyer's premium, pickup hours, dispute window, custom
// terms, sales-tax opt-in.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Field, buttonStyle, inputStyle } from '@/components/Form';
import { saveOperatorPolicies } from './actions';

interface PoliciesFormProps {
  canEdit: boolean;
  initial: {
    buyerPremiumPct: number;
    pickupHoursText: string;
    disputeWindowDays: number;
    customTermsMd: string;
    collectSalesTax: boolean;
    taxMode: 'self_managed' | 'stripe_tax';
    noShowForfeitThreshold: number;
    forfeitCooldownDays: number;
  };
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  resize: 'vertical',
};

export function PoliciesForm({ canEdit, initial }: PoliciesFormProps) {
  const router = useRouter();
  const [buyerPremiumPct, setBuyerPremiumPct] = useState<string>(String(initial.buyerPremiumPct));
  const [pickupHoursText, setPickupHoursText] = useState<string>(initial.pickupHoursText);
  const [disputeWindowDays, setDisputeWindowDays] = useState<string>(
    String(initial.disputeWindowDays),
  );
  const [customTermsMd, setCustomTermsMd] = useState<string>(initial.customTermsMd);
  const [taxMode, setTaxMode] = useState<'self_managed' | 'stripe_tax'>(initial.taxMode);
  // collect_sales_tax is intentionally NOT bound to an input (2026-06-03). The
  // old toggle only attached `shipping` to the PI — it never computed or charged
  // tax (invoices.tax_cents stayed 0), so it was a silent false promise. Real
  // tax via stripe.tax.calculations is task #40. We submit the persisted value
  // unchanged so hiding the toggle never flips an operator's stored setting.
  const [noShowForfeitThreshold, setNoShowForfeitThreshold] = useState<string>(
    String(initial.noShowForfeitThreshold),
  );
  const [forfeitCooldownDays, setForfeitCooldownDays] = useState<string>(
    String(initial.forfeitCooldownDays),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    setSaved(false);
    const pct = Number.parseInt(buyerPremiumPct, 10);
    const dispDays = Number.parseInt(disputeWindowDays, 10);
    if (!Number.isFinite(pct) || pct < 0 || pct > 30) {
      setError('Buyer’s premium must be a whole number from 0 to 30.');
      return;
    }
    if (!Number.isFinite(dispDays) || dispDays < 0 || dispDays > 30) {
      setError('Dispute window must be a whole number from 0 to 30.');
      return;
    }
    const forfeitThreshold = Number.parseInt(noShowForfeitThreshold, 10);
    if (!Number.isFinite(forfeitThreshold) || forfeitThreshold < 1 || forfeitThreshold > 20) {
      setError('No-show forfeit threshold must be a whole number from 1 to 20.');
      return;
    }
    const cooldownDays = Number.parseInt(forfeitCooldownDays, 10);
    if (!Number.isFinite(cooldownDays) || cooldownDays < 0 || cooldownDays > 365) {
      setError('Forfeit cooldown must be a whole number from 0 to 365.');
      return;
    }
    startTransition(async () => {
      const result = await saveOperatorPolicies({
        buyerPremiumPct: pct,
        pickupHoursText: pickupHoursText.trim() ? pickupHoursText : null,
        disputeWindowDays: dispDays,
        customTermsMd: customTermsMd.trim() ? customTermsMd : null,
        collectSalesTax: initial.collectSalesTax,
        taxMode,
        noShowForfeitThreshold: forfeitThreshold,
        forfeitCooldownDays: cooldownDays,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1.5rem', maxWidth: 720 }}>
      <section style={sectionStyle}>
        <h2 style={sectionHeader}>Pricing</h2>
        <Field
          label="Buyer's premium (%)"
          hint="Added to every winning bid. Bidders see this on the auction and lot pages BEFORE they bid. 0–30%."
        >
          <input
            style={{ ...inputStyle, width: 120 }}
            type="number"
            min={0}
            max={30}
            step={1}
            value={buyerPremiumPct}
            onChange={(e) => setBuyerPremiumPct(e.target.value)}
            disabled={!canEdit}
            required
          />
        </Field>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeader}>Pickup &amp; disputes</h2>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <Field
            label="Pickup hours"
            hint="Free-form. Shown on bidder pages so they know when to come collect. eg “Mon–Fri 9–5, Sat 9–12”."
          >
            <textarea
              style={textareaStyle}
              rows={5}
              value={pickupHoursText}
              onChange={(e) => setPickupHoursText(e.target.value)}
              disabled={!canEdit}
              placeholder="Mon–Fri 9am–5pm, Sat 9am–12pm. Closed Sun."
              maxLength={2000}
            />
          </Field>
          <Field
            label="Dispute window (days)"
            hint="How long bidders can dispute after pickup. Default 2 days. Set 0 to make all sales final immediately after pickup. Bidders see this policy before they arrive."
          >
            <input
              style={{ ...inputStyle, width: 120 }}
              type="number"
              min={0}
              max={30}
              step={1}
              value={disputeWindowDays}
              onChange={(e) => setDisputeWindowDays(e.target.value)}
              disabled={!canEdit}
              required
            />
          </Field>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeader}>No-show &amp; forfeit rules</h2>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <Field
            label="No-show forfeit threshold"
            hint="How many no-show pickups (in a rolling 90-day window, counting the current one) it takes before a no-show is escalated to a forfeit — the bidder keeps nothing and the items are relisted. Set 1 for zero tolerance: every no-show forfeits immediately, no history needed. 0 is not allowed (1 already means 'first offense forfeits'). 1–20. Default 3."
          >
            <input
              style={{ ...inputStyle, width: 120 }}
              type="number"
              min={1}
              max={20}
              step={1}
              value={noShowForfeitThreshold}
              onChange={(e) => setNoShowForfeitThreshold(e.target.value)}
              disabled={!canEdit}
              required
            />
          </Field>
          <Field
            label="Forfeit cooldown (days)"
            hint="Grace period after a bidder's forfeit: further no-shows inside this window stay ordinary no-shows instead of triggering another forfeit (protects a bidder from losing several invoices in one bad week). Set 0 for zero tolerance — no grace, every qualifying no-show forfeits. 0–365. Default 30."
          >
            <input
              style={{ ...inputStyle, width: 120 }}
              type="number"
              min={0}
              max={365}
              step={1}
              value={forfeitCooldownDays}
              onChange={(e) => setForfeitCooldownDays(e.target.value)}
              disabled={!canEdit}
              required
            />
          </Field>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeader}>Custom policy text</h2>
        <Field
          label="Anything specific about your auctions"
          hint="Shown on auction + lot pages as your operator-specific addenda. Markdown supported. Use for return policy clarifications, condition disclaimers, weather closures, etc. (Distinct from the platform legal terms bidders accept.)"
        >
          <textarea
            style={textareaStyle}
            rows={20}
            value={customTermsMd}
            onChange={(e) => setCustomTermsMd(e.target.value)}
            disabled={!canEdit}
            placeholder={
              '## Inspection\nAll items are described to the best of our ability.\n\n## Returns\nDispute within 2 days of pickup.'
            }
            maxLength={20000}
          />
        </Field>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeader}>Sales tax</h2>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '0.75rem',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <label
            style={{
              display: 'flex',
              gap: '0.6rem',
              alignItems: 'flex-start',
              cursor: canEdit ? 'pointer' : 'default',
            }}
          >
            <input
              type="radio"
              name="taxMode"
              value="self_managed"
              checked={taxMode === 'self_managed'}
              onChange={() => setTaxMode('self_managed')}
              disabled={!canEdit}
              style={{ marginTop: 3 }}
            />
            <span>
              <div style={{ fontWeight: 600 }}>I collect &amp; remit my own sales tax</div>
              <div style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5 }}>
                You handle registration and remittance for your jurisdiction. When flat-rate tax
                collection is enabled for your account (see Settings → Sales tax), that rate is
                added to invoices at checkout and paid out to you to remit. (Default.)
              </div>
            </span>
          </label>
          <label
            style={{
              display: 'flex',
              gap: '0.6rem',
              alignItems: 'flex-start',
              opacity: 0.55,
              cursor: 'not-allowed',
            }}
          >
            <input
              type="radio"
              name="taxMode"
              value="stripe_tax"
              checked={taxMode === 'stripe_tax'}
              disabled
              readOnly
              style={{ marginTop: 3 }}
            />
            <span>
              <div style={{ fontWeight: 600 }}>
                Automatic — per-jurisdiction tax calculation
              </div>
              <div style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5 }}>
                Computes tax at checkout against your warehouse&rsquo;s jurisdiction
                automatically. Not yet available — the flat-rate option above covers
                single-state operations today.
              </div>
            </span>
          </label>
        </div>
      </section>

      {error && (
        <div
          style={{
            padding: '0.75rem',
            background: 'rgba(248, 113, 113, 0.1)',
            border: '1px solid var(--danger, #f87171)',
            color: 'var(--danger, #f87171)',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="submit" disabled={!canEdit || pending} style={buttonStyle}>
          {pending ? 'Saving…' : 'Save policies'}
        </button>
        {saved && (
          <span style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>✓ Saved</span>
        )}
      </div>
      {!canEdit && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Only operator admins can change these settings.
        </p>
      )}
    </form>
  );
}

const sectionStyle: React.CSSProperties = {
  padding: '1.25rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 8,
};

const sectionHeader: React.CSSProperties = {
  fontSize: 16,
  margin: 0,
  marginBottom: '0.75rem',
};
