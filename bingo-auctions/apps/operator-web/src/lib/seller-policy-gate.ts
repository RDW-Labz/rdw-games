// Seller-policy gate: may this bidder bid with this operator right now?
//
// Same rule as the bidder app (apps/bidder-app/app/lot/[id].tsx, the
// operator_policies / operator_policy_acceptances lookup feeding
// requireAcceptance()):
//   - latest   = operator_policies for the operator, published = true,
//                highest version
//   - accepted = an operator_policy_acceptances row for
//                (user_id, operator_id, that exact version)
//   - no published policy → no gate
//
// A failed lookup is its own answer ('lookup_failed'), so it is never read
// as "this operator has no policy" or cached. The widget still lets the bid
// through, as the app does: the gate must not become a new way to lose a bid.
//
// Pure so it can be tested — vitest in operator-web is node-env, logic only.

export type SellerPolicyGate = 'no_policy' | 'accepted' | 'needs_acceptance' | 'lookup_failed';

/** The fields of the latest published operator_policies row the decision needs. */
export interface SellerPolicyRef {
  operator_id: string;
  version: number;
}

export function decideSellerPolicyGate(input: {
  /** Latest published policy for the lot's operator, or null when there is none. */
  policy: SellerPolicyRef | null;
  /** True when the operator_policies query errored (policy is then meaningless). */
  policyLookupFailed: boolean;
  /** Acceptance rows matching (user, operator, policy.version); null if the
   *  count query returned no answer. */
  acceptanceCount: number | null;
}): SellerPolicyGate {
  if (input.policyLookupFailed) return 'lookup_failed';
  if (!input.policy) return 'no_policy';
  // null is not proof of acceptance. Asking again only adds another
  // acceptance row, so the safe side is to ask.
  return (input.acceptanceCount ?? 0) > 0 ? 'accepted' : 'needs_acceptance';
}
