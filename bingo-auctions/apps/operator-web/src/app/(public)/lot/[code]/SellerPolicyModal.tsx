// Seller-policy acceptance gate for web bids.
//
// Web twin of apps/bidder-app/app/lot/_OperatorPolicyModal.tsx: before a
// bidder's first bid with an operator at its latest published policy
// version, they read the operator's Terms / Refund / Shipping documents,
// tick the agreement box, and accept. Acceptance is recorded exactly as the
// app does it — record_operator_consent(p_operator_id, p_version), which
// writes operator_policy_acceptances with IP + UA taken server-side from the
// request headers (mig 0088, published-only check from mig 0091).
//
// The parent (BidWidget) owns the bid: this component only records consent
// and reports accept / cancel. Cancel never bids.

'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

export type SellerPolicyForModal = {
  operator_id: string;
  version: number;
  terms_md: string | null;
  refund_md: string | null;
  shipping_md: string | null;
};

type Tab = 'terms' | 'refund' | 'shipping';

const TAB_LABELS: Record<Tab, string> = {
  terms: 'Terms',
  refund: 'Refund',
  shipping: 'Shipping',
};

export function SellerPolicyModal({
  policy,
  operatorName,
  onAccepted,
  onCancel,
}: {
  policy: SellerPolicyForModal;
  operatorName: string;
  onAccepted: () => void;
  onCancel: () => void;
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [tab, setTab] = useState<Tab>('terms');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape = Cancel, same as the Lightbox overlay. Ignored mid-submit so a
  // recorded acceptance can't be orphaned from the bid it was for.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !submitting) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  async function accept() {
    setError(null);
    setSubmitting(true);
    const { error: rpcErr } = await supabase.rpc('record_operator_consent', {
      p_operator_id: policy.operator_id,
      p_version: policy.version,
    });
    setSubmitting(false);
    if (rpcErr) {
      setError(rpcErr.message || 'Could not record your acceptance. Please try again.');
      return;
    }
    onAccepted();
  }

  const body =
    (tab === 'terms' ? policy.terms_md : tab === 'refund' ? policy.refund_md : policy.shipping_md) ??
    '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="seller-policy-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.65)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 640,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem 0.75rem' }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
            }}
          >
            Bidding with {operatorName}
          </div>
          <div id="seller-policy-title" style={{ fontSize: '1.25rem', fontWeight: 900, marginTop: 4 }}>
            Review &amp; accept their terms
          </div>
        </div>

        <div role="tablist" style={{ display: 'flex', gap: 8, padding: '0 1.5rem 0.5rem' }}>
          {(['terms', 'refund', 'shipping'] as Tab[]).map((t) => {
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t)}
                style={{
                  padding: '0.45rem 0.9rem',
                  borderRadius: 999,
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'transparent',
                  color: active ? 'var(--accent)' : 'var(--fg)',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: 0.3,
                }}
              >
                {TAB_LABELS[t]}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          style={{
            overflowY: 'auto',
            padding: '0.25rem 1.5rem 0.75rem',
            fontSize: 14,
            lineHeight: 1.6,
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
            flex: 1,
            minHeight: 160,
          }}
        >
          {body.trim() ? (
            // Headings scaled down from the /legal page's sizes to fit a dialog.
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h3 style={{ fontSize: '1.15rem', margin: '0.75rem 0 0.4rem' }}>{children}</h3>,
                h2: ({ children }) => <h4 style={{ fontSize: '1rem', margin: '0.75rem 0 0.3rem' }}>{children}</h4>,
                h3: ({ children }) => <h5 style={{ fontSize: '0.95rem', margin: '0.6rem 0 0.25rem' }}>{children}</h5>,
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                    {children}
                  </a>
                ),
                ul: ({ children }) => <ul style={{ paddingLeft: '1.5rem' }}>{children}</ul>,
              }}
            >
              {body}
            </ReactMarkdown>
          ) : (
            <p style={{ color: 'var(--fg-muted)' }}>This operator has not published this section.</p>
          )}
        </div>

        <div style={{ padding: '0.9rem 1.5rem 1.25rem', display: 'grid', gap: '0.75rem' }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              I have read and agree to {operatorName}&apos;s Terms, Refund Policy, and Shipping Policy.
            </span>
          </label>

          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 700 }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="btn-secondary"
              style={{ flex: 1, padding: '0.85rem', opacity: submitting ? 0.5 : 1 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={accept}
              disabled={!agreed || submitting}
              className="btn-primary"
              style={{
                flex: 1,
                padding: '0.85rem',
                opacity: !agreed || submitting ? 0.5 : 1,
                cursor: !agreed ? 'not-allowed' : submitting ? 'wait' : 'pointer',
              }}
            >
              {submitting ? 'Saving…' : 'Accept and bid'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
