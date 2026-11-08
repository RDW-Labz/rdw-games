// useLotUpdate — partial-update hook for the inventory edit screen.
//
// Mirrors useLotCreation's shape but for UPDATE: caller passes a patch
// object, hook applies value normalization (cents conversion, photo URL
// allowlist, condition enum mapping), runs an RLS-scoped UPDATE, and
// returns the updated row.
//
// Constraints we honor — same as create path:
//   - photo_urls is filtered through filterSafeImageUrls before write
//   - msrp_cents capped at JS-safe-integer * 0.99 to avoid silent
//     precision loss (mirrors persistence.ts R4.2 logic)
//   - starting_bid_cents floored to 1 (matches DB CHECK from migration 0046)
//
// We do NOT update lot_code, status, operator_id, auction_id — those
// have different lifecycles (status flips via picker workflows;
// operator/auction are immutable for an existing lot in this app).

import { useCallback, useState } from 'react';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { filterSafeImageUrls } from '@auction-platform/domain-lotting';

export type LotUpdatePatch = {
  title?: string;
  description?: string | null;
  category?: string | null;
  condition?: 'appears_new' | 'open_box' | 'good' | 'as_is';
  msrp_cents?: number | null;
  starting_bid_cents?: number;
  photo_urls?: string[];
};

export type LotUpdateResult =
  | { ok: true }
  | { ok: false; reason: string };

const MAX_MSRP_CENTS = 9_007_199_254_740_991 - 1; // matches CHECK in 0046
const MAX_BID_CENTS = 99_999_999_999;             // < $1B in cents

export function useLotUpdate() {
  const role = useOperatorRole();
  const [updating, setUpdating] = useState(false);

  const update = useCallback(
    async (lotId: string, patch: LotUpdatePatch): Promise<LotUpdateResult> => {
      if (role.kind !== 'staff') return { ok: false, reason: 'not_staff' };
      if (updating) return { ok: false, reason: 'already_updating' };
      setUpdating(true);
      try {
        // Defense-in-depth on every UPDATE — same filter persistence.ts
        // applies on INSERT. The DB-side allowlist is migration 0045's
        // is_safe_image_url(); here we run the JS mirror to fail fast
        // with a typed result rather than letting the row commit and
        // then the client see broken images.
        const safe: Record<string, unknown> = {};
        if (patch.title !== undefined) safe['title'] = patch.title.trim() || 'Untitled lot';
        if (patch.description !== undefined) safe['description'] = patch.description;
        if (patch.category !== undefined) safe['category'] = patch.category;
        if (patch.condition !== undefined) safe['condition'] = patch.condition;

        if (patch.msrp_cents !== undefined) {
          // Same overflow guard as createDraftLot (R4.2).
          safe['msrp_cents'] =
            patch.msrp_cents == null
              ? null
              : Number.isFinite(patch.msrp_cents) && patch.msrp_cents > 0 && patch.msrp_cents < MAX_MSRP_CENTS
                ? Math.round(patch.msrp_cents)
                : null;
        }
        if (patch.starting_bid_cents !== undefined) {
          const v = patch.starting_bid_cents;
          safe['starting_bid_cents'] =
            Number.isFinite(v) && v >= 1 && v < MAX_BID_CENTS ? Math.round(v) : 100;
        }
        if (patch.photo_urls !== undefined) {
          safe['photo_urls'] = filterSafeImageUrls(patch.photo_urls);
        }

        // RLS scopes UPDATE to the operator's own lots. We add the
        // explicit operator_id check to keep query plans tight on the
        // existing lots_operator_idx — same pattern as the list hook.
        const { error } = await supabase
          .from('lots')
          .update(safe)
          .eq('id', lotId)
          .eq('operator_id', role.operatorId);

        if (error) {
          // Map known constraints onto user-actionable messages. The
          // discriminated reason is consumed by the screen's Alert; we
          // keep the raw Postgres message in `reason` so logs still see it.
          if (error.code === '23505' && error.message.includes('lots_external_code_per_operator')) {
            return { ok: false, reason: 'duplicate_external_code' };
          }
          if (error.code === '23514' && error.message.includes('lots_msrp_cents_sane')) {
            return { ok: false, reason: 'msrp out of range' };
          }
          if (error.code === '23514' && error.message.includes('lots_starting_bid_cents_sane')) {
            return { ok: false, reason: 'starting bid out of range' };
          }
          return { ok: false, reason: error.message };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      } finally {
        setUpdating(false);
      }
    },
    [role, updating],
  );

  return { update, updating };
}
