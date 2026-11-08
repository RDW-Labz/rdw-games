// OperatorPolicyModal — first-bid acceptance gate for per-operator
// policies (migration 0088).
//
// Each operator on BinGo Auctions publishes their own Terms of Service, Refund
// Policy, and Shipping Policy (operator_policies table). Before a bidder
// places their first bid with that operator at the current published
// version, they must affirmatively accept those documents. We persist
// the acceptance via the record_operator_consent() RPC (writes to
// operator_policy_acceptances with IP + UA captured server-side from
// PostgREST request headers — same shape as the platform-level
// terms_acceptances added in migration 0081).
//
// UX notes:
//   - Three tabs (Terms / Refund / Shipping). Tabs vs a single long
//     scroll because the three docs are conceptually distinct — bidders
//     may want to skim one without reading all three. Each tab is its
//     own scroll surface so a long Terms doc doesn't push the Refund
//     section off-screen.
//   - An "I have read and agree to all three documents" checkbox gates
//     the "Accept & bid" CTA. Tap-to-bid without affirmative consent is
//     not E-SIGN-friendly.
//   - "Cancel" closes without bidding — the placeholder bid amount is
//     preserved by the parent (we never write to the bid input here).
//   - No external markdown renderer dependency. We do a tiny
//     heading/list/link pass on the raw markdown to make it readable.
//     The corpus is small (~200 lines max), so a bespoke pass beats
//     adding ~80kb of react-native-markdown-display to the bundle.

import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

export type OperatorPolicyForModal = {
  operator_id: string;
  version: number;
  terms_md: string;
  refund_md: string;
  shipping_md: string;
};

export type OperatorPolicyModalProps = {
  visible: boolean;
  operatorBusinessName: string;
  // Effective buyer's premium (basis points) for the lot being bid on. Shown
  // prominently at this agreement gate per the owner's fee-disclosure model
  // (disclosed when accepting terms — not on every lot face). Optional/nullable
  // so the modal degrades gracefully if the value hasn't loaded.
  buyerPremiumBps?: number | null;
  policy: OperatorPolicyForModal | null;
  onCancel: () => void;
  onAccepted: () => void;
};

type Tab = 'terms' | 'refund' | 'shipping';

const TAB_LABELS: Record<Tab, string> = {
  terms: 'Terms',
  refund: 'Refund',
  shipping: 'Shipping',
};

// Tiny markdown line-renderer. We support: # headings (1–3 levels),
// bullets (- or *), and inline [text](url) links. Everything else
// renders as a plain paragraph. The goal is "make a ~200-line doc
// look like a doc on mobile" — not full CommonMark.
function MarkdownLines({ body }: { body: string }) {
  const lines = useMemo(() => body.split(/\r?\n/), [body]);
  return (
    <View>
      {lines.map((rawLine, i) => {
        const line = rawLine.replace(/\t/g, '    ');
        // Blank line → spacer
        if (line.trim() === '') {
          return <View key={i} style={{ height: 8 }} />;
        }
        // Headings
        const h1 = line.match(/^# (.*)$/);
        if (h1) {
          return (
            <Text
              key={i}
              style={{
                color: colors.text,
                fontSize: 18,
                fontWeight: '900',
                marginTop: i === 0 ? 0 : 12,
                marginBottom: 6,
              }}
            >
              {h1[1]}
            </Text>
          );
        }
        const h2 = line.match(/^## (.*)$/);
        if (h2) {
          return (
            <Text
              key={i}
              style={{
                color: colors.text,
                fontSize: 15,
                marginTop: 10,
                marginBottom: 4,
                ...type.label, // already sets fontWeight
              }}
            >
              {h2[1]}
            </Text>
          );
        }
        const h3 = line.match(/^### (.*)$/);
        if (h3) {
          return (
            <Text
              key={i}
              style={{
                color: colors.textMuted,
                fontSize: 13,
                fontWeight: '700',
                marginTop: 8,
                marginBottom: 4,
              }}
            >
              {h3[1]}
            </Text>
          );
        }
        // Bullets
        const bullet = line.match(/^\s*[-*] (.*)$/);
        if (bullet) {
          return (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                marginVertical: 2,
              }}
            >
              <Text style={{ color: colors.textMuted, marginRight: 6 }}>•</Text>
              <Text
                style={{
                  color: colors.text,
                  fontSize: 14,
                  lineHeight: 20,
                  flex: 1,
                }}
              >
                {renderInline(bullet[1] ?? '')}
              </Text>
            </View>
          );
        }
        // Paragraph
        return (
          <Text
            key={i}
            style={{
              color: colors.text,
              fontSize: 14,
              lineHeight: 20,
              marginVertical: 2,
            }}
          >
            {renderInline(line)}
          </Text>
        );
      })}
    </View>
  );
}

// Render inline [text](url) links + leave other text alone. Returns an
// array of <Text> nodes for the parent <Text> to interleave.
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Match [label](http(s)://...) or [label](/path)
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<Text key={key++}>{text.slice(last, m.index)}</Text>);
    }
    const label = m[1] ?? '';
    const href = m[2] ?? '';
    out.push(
      <Text
        key={key++}
        onPress={() => {
          // Only follow http(s) — bare paths like /legal/terms don't
          // resolve from inside the mobile app; surface them as plain
          // text so we don't crash openURL.
          if (href.startsWith('http://') || href.startsWith('https://')) {
            Linking.openURL(href).catch(() => {});
          }
        }}
        style={{ color: colors.primary, textDecorationLine: 'underline' }}
      >
        {label}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(<Text key={key++}>{text.slice(last)}</Text>);
  }
  return out;
}

export function OperatorPolicyModal(props: OperatorPolicyModalProps) {
  const [tab, setTab] = useState<Tab>('terms');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!props.policy) return;
    setError(null);
    setSubmitting(true);
    const { error: rpcErr } = await supabase.rpc('record_operator_consent', {
      p_operator_id: props.policy.operator_id,
      p_version: props.policy.version,
    });
    setSubmitting(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    // Reset state for the next open (e.g. the user later bids on another
    // operator they haven't accepted yet).
    setAccepted(false);
    setTab('terms');
    props.onAccepted();
  }

  function cancel() {
    setAccepted(false);
    setTab('terms');
    setError(null);
    props.onCancel();
  }

  const body = useMemo(() => {
    if (!props.policy) return '';
    return tab === 'terms'
      ? props.policy.terms_md
      : tab === 'refund'
        ? props.policy.refund_md
        : props.policy.shipping_md;
  }, [props.policy, tab]);

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      transparent
      onRequestClose={cancel}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.65)',
          justifyContent: 'flex-end',
        }}
      >
        <View
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            paddingTop: 12,
            paddingBottom: 18,
            maxHeight: '90%',
            borderTopWidth: 1,
            borderColor: colors.border,
          }}
        >
          {/* Grabber */}
          <View
            style={{
              alignSelf: 'center',
              width: 44,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.border,
              marginBottom: 12,
            }}
          />

          <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 11,
                ...type.label,
              }}
            >
              First bid with {props.operatorBusinessName}
            </Text>
            <Text
              style={{
                color: colors.text,
                fontSize: 18,
                marginTop: 4,
                ...type.display,
              }}
            >
              Review &amp; accept their terms
            </Text>
          </View>

          {/* Buyer's premium — agreement-time fee disclosure (owner model:
              shown when accepting operator terms, not on every lot face). */}
          {props.buyerPremiumBps != null && (
            <View
              style={{
                marginHorizontal: 18,
                marginBottom: 12,
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surfaceHi,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>
                {`Buyer's premium: ${props.buyerPremiumBps / 100}% added to your winning bid`}
              </Text>
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 11,
                  marginTop: 3,
                  lineHeight: 16,
                }}
              >
                Charged at checkout on top of your winning bid. You can review this
                anytime in the operator&apos;s terms.
              </Text>
            </View>
          )}

          {/* Tabs */}
          <View
            style={{
              flexDirection: 'row',
              gap: 8,
              paddingHorizontal: 18,
              marginBottom: 8,
            }}
          >
            {(['terms', 'refund', 'shipping'] as Tab[]).map((t) => {
              const active = tab === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setTab(t)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={TAB_LABELS[t]}
                  style={{
                    minHeight: 44,
                    justifyContent: 'center',
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.border,
                    backgroundColor: active
                      ? colors.primaryDim
                      : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.primary : colors.text,
                      fontSize: 12,
                      fontWeight: '800',
                      letterSpacing: 0.3,
                    }}
                  >
                    {TAB_LABELS[t]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Body */}
          <ScrollView
            style={{
              maxHeight: 420,
              paddingHorizontal: 18,
              paddingTop: 4,
              paddingBottom: 8,
            }}
            contentContainerStyle={{ paddingBottom: 12 }}
          >
            {!props.policy ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : (
              <MarkdownLines body={body} />
            )}
          </ScrollView>

          {/* Footer */}
          <View
            style={{
              borderTopWidth: 1,
              borderColor: colors.border,
              paddingHorizontal: 18,
              paddingTop: 12,
              gap: 10,
            }}
          >
            <Pressable
              onPress={() => setAccepted((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: accepted }}
              accessibilityLabel={`I agree to ${props.operatorBusinessName}'s Terms, Refund Policy, and Shipping Policy`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 44,
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  borderWidth: 2,
                  borderColor: accepted ? colors.primary : colors.border,
                  backgroundColor: accepted ? colors.primary : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {accepted && (
                  <Text style={{ color: '#000', fontWeight: '900' }}>✓</Text>
                )}
              </View>
              <Text
                style={{
                  color: colors.text,
                  fontSize: 13,
                  lineHeight: 18,
                  flex: 1,
                }}
              >
                I have read and agree to {props.operatorBusinessName}&apos;s
                Terms, Refund Policy, and Shipping Policy.
              </Text>
            </Pressable>

            {error && (
              <Text
                style={{
                  color: colors.danger,
                  fontSize: 12,
                  fontWeight: '700',
                }}
              >
                {error}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={cancel}
                disabled={submitting}
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: 'transparent',
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                <Text
                  style={{
                    color: colors.text,
                    textAlign: 'center',
                    fontSize: 14,
                    fontWeight: '700',
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={accept}
                disabled={!accepted || submitting || !props.policy}
                accessibilityRole="button"
                accessibilityLabel="Accept and place bid"
                accessibilityHint={
                  !accepted
                    ? 'Disabled until you accept the policies above'
                    : submitting
                      ? 'Submitting your acceptance'
                      : undefined
                }
                accessibilityState={{
                  disabled: !accepted || submitting || !props.policy,
                  busy: submitting,
                }}
                style={{
                  flex: 1.4,
                  padding: 14,
                  borderRadius: 12,
                  backgroundColor:
                    accepted && !submitting && props.policy
                      ? colors.primary
                      : colors.surfaceHi,
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text
                    style={{
                      color:
                        accepted && props.policy ? '#000' : colors.textMuted,
                      textAlign: 'center',
                      fontSize: 14,
                      ...type.label,
                    }}
                  >
                    Accept and bid
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
