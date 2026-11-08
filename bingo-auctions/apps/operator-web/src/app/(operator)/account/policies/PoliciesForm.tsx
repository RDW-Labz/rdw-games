'use client';

// PoliciesForm — client wrapper around the saveDraft / publishPolicy
// server actions for /account/policies.
//
// Three states:
//   - "view"  : show the active published policy + draft (if any) as
//               read-only cards. Default state.
//   - "edit"  : show the form pre-filled from draft (preferred) or
//               active. Two submit buttons: Save as draft, Publish.
//
// Why view-first: the editor is dense (3 markdown textareas + 4 numeric
// fields) and 99% of the time the admin just wants to verify what's
// live. Hide the cognitive load until they tap Edit.
//
// We don't show a markdown preview pane — operators write small,
// structured docs (~200 lines max) and the bidder modal renders the
// markdown in-app. A preview adds a second source of truth without
// changing what bidders actually see. Skip it for v1; the published
// view below dumps the rendered text as a monospace block which is
// "close enough" for proofreading.

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveDraft, publishPolicy, type PolicyActionResult } from './actions';
import { inputStyle, buttonStyle, secondaryButtonStyle } from '@/components/Form';

export type PolicyShape = {
  operator_id: string;
  version: number;
  terms_md: string;
  refund_md: string;
  shipping_md: string;
  payment_window_hours: number; // deprecated 2026-05-29 — display-only, kept for historical compatibility
  pickup_window_days: number;
  refund_window_post_pickup_hours: number;
  // PR-A1 additions (2026-05-29):
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
  restock_fee_cents: number;
  relist_fee_cents: number;
  admin_can_refund_outside_window: boolean;
  // CHK-01 / CHK-02 (checkout improvements, mig 0193):
  require_identity_check: boolean;
  identity_check_threshold_cents: number;
  require_signature: boolean;
  effective_at: string;
  published: boolean;
  content_hash: string;
  created_at: string;
};

const sectionStyle: React.CSSProperties = {
  padding: '1rem 1.25rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  marginBottom: '1.25rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--fg-muted)',
  display: 'block',
  marginBottom: 4,
};

const monoTextareaStyle: React.CSSProperties = {
  ...inputStyle,
  width: '100%',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
  fontSize: 13,
  lineHeight: 1.5,
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Read-only snapshot of one policy version. Used for the "active" and
// "draft" cards in view mode.
function PolicySnapshot({
  policy,
  badge,
}: {
  policy: PolicyShape;
  badge: 'published' | 'draft';
}) {
  const isPublished = badge === 'published';
  return (
    <section style={sectionStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '0.75rem',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>
          Version {policy.version}
          <span
            style={{
              display: 'inline-block',
              marginLeft: 10,
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              background: isPublished
                ? 'rgba(34, 197, 94, 0.15)'
                : 'rgba(255, 214, 10, 0.15)',
              color: isPublished ? 'var(--accent)' : 'var(--winning)',
            }}
          >
            {isPublished ? 'Live' : 'Draft'}
          </span>
        </h2>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          {isPublished ? 'Effective ' : 'Saved '}
          {formatRelative(isPublished ? policy.effective_at : policy.created_at)}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '0.5rem',
          marginBottom: '0.85rem',
        }}
      >
        {/* Payment window deprecated 2026-05-29 — auto-charge fires immediately
            at lot close regardless. Field hidden from UI per PR-A1. */}
        <KeyValue
          label="Pickup window"
          value={`${policy.pickup_window_days} days`}
        />
        {/* Shipping availability moved to Settings → Fulfillment
            (operators.offers_shipping) — the single source of truth read by
            checkout, the shipping-quote API, and the bidder lot page. The
            duplicate operator_policies.shipping_offered flag was removed. */}
        <KeyValue
          label="Post-pickup refund"
          value={
            policy.refund_window_post_pickup_hours === 0
              ? 'No (all sales final)'
              : `${policy.refund_window_post_pickup_hours}h window`
          }
        />
        <KeyValue
          label="No-show policy"
          value={
            policy.no_show_policy === 'full_forfeit'
              ? 'Full forfeiture'
              : 'Refund minus restock fee'
          }
        />
        <KeyValue
          label="Restock fee"
          value={`$${(policy.restock_fee_cents / 100).toFixed(2)}`}
        />
        <KeyValue
          label="Relist fee (failed-charge no-show)"
          value={`$${(policy.relist_fee_cents / 100).toFixed(2)}`}
        />
        <KeyValue
          label="Admin override outside refund window"
          value={policy.admin_can_refund_outside_window ? 'Enabled' : 'Disabled'}
        />
        {/* CHK-01 / CHK-02 checkout-flow toggles. */}
        <KeyValue
          label="Identity check at pickup"
          value={
            !policy.require_identity_check
              ? 'Off'
              : policy.identity_check_threshold_cents === 0
                ? 'Always required'
                : `Required at $${(policy.identity_check_threshold_cents / 100).toFixed(2)}+`
          }
        />
        <KeyValue
          label="Signature at pickup"
          value={policy.require_signature ? 'Required' : 'Off'}
        />
      </div>

      <details style={{ marginBottom: 0 }}>
        <summary
          style={{
            cursor: 'pointer',
            color: 'var(--fg-muted)',
            fontSize: 13,
            padding: '0.4rem 0',
          }}
        >
          Show policy text
        </summary>
        <ReadonlyMd label="Terms" body={policy.terms_md} />
        <ReadonlyMd label="Refund Policy" body={policy.refund_md} />
        <ReadonlyMd label="Shipping Policy" body={policy.shipping_md} />
      </details>
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: '0.5rem 0.75rem',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: 'var(--fg)' }}>{value}</div>
    </div>
  );
}

function ReadonlyMd({ label, body }: { label: string; body: string }) {
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <pre
        style={{
          ...monoTextareaStyle,
          margin: 0,
          whiteSpace: 'pre-wrap',
          maxHeight: 280,
          overflow: 'auto',
        }}
      >
        {body}
      </pre>
    </div>
  );
}

function SubmitButton({
  label,
  intent,
}: {
  label: string;
  intent: 'primary' | 'secondary';
}) {
  // Disable while pending so a double-tap doesn't fire both server
  // actions back-to-back (they'd each version-bump independently).
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        ...(intent === 'primary' ? buttonStyle : secondaryButtonStyle),
        opacity: pending ? 0.5 : 1,
      }}
    >
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function PoliciesForm({
  operatorId,
  isAdmin,
  active,
  draft,
}: {
  operatorId: string;
  isAdmin: boolean;
  active: PolicyShape | null;
  draft: PolicyShape | null;
}) {
  void operatorId; // not used client-side; server actions resolve via auth.uid()

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [result, setResult] = useState<PolicyActionResult | null>(null);

  // Seed defaults from draft → active → factory defaults. Edit form is
  // uncontrolled (HTML form-data) so we just need the initial values; the
  // server action reads from FormData on submit.
  const seed = draft ?? active;

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>,
    fn: typeof saveDraft,
  ): Promise<void> {
    e.preventDefault();
    setResult(null);
    const fd = new FormData(e.currentTarget);
    const r = await fn(fd);
    setResult(r);
    if (r.ok) setMode('view');
  }

  if (mode === 'view') {
    return (
      <div>
        {active ? (
          <PolicySnapshot policy={active} badge="published" />
        ) : (
          <div
            style={{
              ...sectionStyle,
              borderColor: 'rgba(255, 59, 59, 0.4)',
              background: 'rgba(255, 59, 59, 0.05)',
            }}
          >
            <strong style={{ color: 'var(--danger)' }}>No live policy</strong>
            <p
              style={{
                margin: '0.4rem 0 0 0',
                color: 'var(--fg-muted)',
                fontSize: 13,
              }}
            >
              Bidders can&apos;t accept terms with you because none are
              published. Edit below and publish v1.
            </p>
          </div>
        )}

        {draft && <PolicySnapshot policy={draft} badge="draft" />}

        {result && !result.ok && (
          <div
            style={{
              color: 'var(--danger)',
              fontSize: 13,
              marginBottom: '0.75rem',
            }}
          >
            {result.error}
          </div>
        )}

        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setMode('edit');
              setResult(null);
            }}
            style={buttonStyle}
          >
            {active ? 'Edit policies' : 'Create policies'}
          </button>
        )}
      </div>
    );
  }

  // Edit mode
  return (
    <form
      // We dispatch to saveDraft by default; the Publish button overrides
      // via formAction on the button itself. This keeps the single <form>
      // wrapping both submit buttons (avoids two side-by-side forms which
      // would duplicate every field).
      onSubmit={(e) => handleSubmit(e, saveDraft)}
    >
      {/* ── Policy bodies ─────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <label style={labelStyle} htmlFor="terms_md">
          Terms of Service (markdown)
        </label>
        <textarea
          id="terms_md"
          name="terms_md"
          rows={12}
          defaultValue={seed?.terms_md ?? ''}
          required
          minLength={20}
          maxLength={50_000}
          style={monoTextareaStyle}
        />
      </section>

      <section style={sectionStyle}>
        <label style={labelStyle} htmlFor="refund_md">
          Refund Policy (markdown)
        </label>
        <textarea
          id="refund_md"
          name="refund_md"
          rows={8}
          defaultValue={seed?.refund_md ?? ''}
          required
          minLength={20}
          maxLength={50_000}
          style={monoTextareaStyle}
        />
      </section>

      <section style={sectionStyle}>
        <label style={labelStyle} htmlFor="shipping_md">
          Shipping Policy (markdown)
        </label>
        <textarea
          id="shipping_md"
          name="shipping_md"
          rows={6}
          defaultValue={seed?.shipping_md ?? ''}
          required
          minLength={20}
          maxLength={50_000}
          style={monoTextareaStyle}
        />
      </section>

      {/* ── Operational fields ──────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Operations</h2>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          {/* payment_window_hours hidden 2026-05-29 (PR-A1). Auto-charge fires
              immediately at lot close — the column is display-only and the
              prior value is preserved here so the policy doc hash stays stable
              when the operator edits other fields. */}
          <input
            type="hidden"
            name="payment_window_hours"
            value={seed?.payment_window_hours ?? 0}
          />

          <div>
            <label style={labelStyle} htmlFor="pickup_window_days">
              Pickup window (days)
            </label>
            <input
              id="pickup_window_days"
              name="pickup_window_days"
              type="number"
              min={1}
              max={30}
              defaultValue={seed?.pickup_window_days ?? 7}
              required
              style={inputStyle}
            />
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              How long bidders have to collect after auction close.
            </span>
          </div>

          <div>
            <label style={labelStyle} htmlFor="refund_window_post_pickup_hours">
              Post-pickup refund window (hours)
            </label>
            <input
              id="refund_window_post_pickup_hours"
              name="refund_window_post_pickup_hours"
              type="number"
              min={0}
              max={720}
              defaultValue={seed?.refund_window_post_pickup_hours ?? 0}
              required
              style={inputStyle}
            />
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              0 = all sales final after pickup. Max 720 (30 days).
            </span>
          </div>

        </div>
      </section>

      {/* ── No-show + refund policy (PR-A1, 2026-05-29) ──────────────────── */}
      <section style={sectionStyle}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>No-show + refund policy</h2>
        <p
          style={{
            margin: '0 0 1rem 0',
            color: 'var(--fg-muted)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Behavior when a bidder fails to pick up, fees you charge for
          relisting, and whether admin can override the post-pickup refund
          window. Defaults preserve the BidFTA-style full-forfeiture model.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          <div>
            <label style={labelStyle} htmlFor="no_show_policy">
              No-show outcome
            </label>
            <select
              id="no_show_policy"
              name="no_show_policy"
              defaultValue={seed?.no_show_policy ?? 'full_forfeit'}
              required
              style={inputStyle}
            >
              {/* "Refund minus restock fee" was removed 2026-09-16. Choosing it
                  pushed the bidder a "refund pending" notification and enqueued
                  a refund_jobs row — but the drain worker was deleted in the
                  Square cutover, so the refund would never have been issued.
                  Re-add this option only together with a working drainer. The
                  DB CHECK still permits the value, and every display branch
                  still renders it correctly, so a legacy row reads truthfully. */}
              <option value="full_forfeit">Full forfeiture (default)</option>
            </select>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              Full forfeiture: you keep payment, lot relists.
            </span>
          </div>

          <div>
            <label style={labelStyle} htmlFor="restock_fee_cents">
              Restock fee ($)
            </label>
            <input
              id="restock_fee_cents"
              name="restock_fee_cents"
              type="number"
              min={0}
              max={10000}
              step="0.01"
              defaultValue={((seed?.restock_fee_cents ?? 500) / 100).toFixed(2)}
              required
              style={inputStyle}
            />
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              Deducted from any refund (post-pickup, admin override, or
              refund-minus-restock no-show). Max $10,000.
            </span>
          </div>

          <div>
            <label style={labelStyle} htmlFor="relist_fee_cents">
              Relist fee for failed-charge no-show ($)
            </label>
            <input
              id="relist_fee_cents"
              name="relist_fee_cents"
              type="number"
              min={0}
              max={10000}
              step="0.01"
              defaultValue={((seed?.relist_fee_cents ?? 500) / 100).toFixed(2)}
              required
              style={inputStyle}
            />
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              Added to bidder&apos;s outstanding balance when their card
              declines and grace expires. Bidder is blocked from bidding until
              cleared. Max $10,000.
            </span>
          </div>

          <div style={{ alignSelf: 'end' }}>
            <label
              style={{
                ...labelStyle,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: 0,
                color: 'var(--fg)',
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                name="admin_can_refund_outside_window"
                defaultChecked={seed?.admin_can_refund_outside_window ?? true}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              Admin override outside refund window
            </label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              When enabled, admins (not managers) can approve refunds outside
              the post-pickup window. Each override is logged to the audit
              log with a required reason.
            </span>
          </div>
        </div>
      </section>

      {/* ── Checkout flow (CHK-01 / CHK-02) ──────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Checkout flow</h2>
        <p
          style={{
            margin: '0 0 1rem 0',
            color: 'var(--fg-muted)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Controls how the staff pickup-verify screen behaves at the counter.
          Defaults preserve today&apos;s flow: identity is always confirmed and
          signature capture is optional.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          <div style={{ alignSelf: 'start' }}>
            <label
              style={{
                ...labelStyle,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: 0,
                color: 'var(--fg)',
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                name="require_identity_check"
                defaultChecked={seed?.require_identity_check ?? true}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              Require identity confirmation
            </label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              When on, staff must confirm the bidder&apos;s identity before
              handing over items. Turn off to skip straight to lot verification.
            </span>
          </div>

          <div>
            <label style={labelStyle} htmlFor="identity_check_threshold_dollars">
              Identity check threshold ($)
            </label>
            <input
              id="identity_check_threshold_dollars"
              name="identity_check_threshold_dollars"
              type="number"
              min={0}
              max={1000000}
              step="0.01"
              defaultValue={(
                (seed?.identity_check_threshold_cents ?? 0) / 100
              ).toFixed(2)}
              required
              style={inputStyle}
            />
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              0 = always require the identity step. Above 0, it&apos;s only
              required when the invoice total is at or above this amount. Ignored
              when identity confirmation is off.
            </span>
          </div>

          <div style={{ alignSelf: 'start' }}>
            <label
              style={{
                ...labelStyle,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: 0,
                color: 'var(--fg)',
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                name="require_signature"
                defaultChecked={seed?.require_signature ?? false}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              Require signature at pickup
            </label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginTop: 4,
              }}
            >
              When on, the bidder signs on the staff device before pickup is
              confirmed. Off (default) takes signature out of the standard flow.
            </span>
          </div>
        </div>
      </section>

      {result && !result.ok && (
        <div
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            marginBottom: '0.75rem',
          }}
        >
          {result.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <SubmitButton label="Save as draft" intent="secondary" />
        {/* Publish button uses formAction to override the form's
            saveDraft handler. We can't use a separate onClick + manual
            FormData here because then the formAction prop is the wrong
            shape; instead we attach a click handler that retargets the
            submit handler to publishPolicy via an in-component piece of
            state. Simpler: a separate form-bound handler on a second
            button by listening to a "published" hidden marker. We use
            a hidden input mutation approach. */}
        <button
          type="button"
          onClick={async (e) => {
            const form = (e.currentTarget as HTMLButtonElement).closest('form');
            if (!form) return;
            const fd = new FormData(form);
            setResult(null);
            const r = await publishPolicy(fd);
            setResult(r);
            if (r.ok) setMode('view');
          }}
          style={buttonStyle}
        >
          Publish (live to bidders)
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('view');
            setResult(null);
          }}
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
      </div>

      <p
        style={{
          marginTop: '1rem',
          color: 'var(--fg-muted)',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        Publishing creates a new version. Bidders who&apos;ve previously
        accepted an older version will be re-prompted on their next bid.
      </p>
    </form>
  );
}
