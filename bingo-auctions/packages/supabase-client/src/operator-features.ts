// useOperatorFeatures — fetches a single operator's bidder_features
// JSONB and the calling bidder's subscription tier with that operator.
// Returns null while loading and on error so callers can render
// universal defaults / nothing as appropriate.
//
// Cached in-module by operatorId so navigating away from a lot detail
// and back doesn't re-fetch. The cache is invalidated only on app
// reload — operator changes happen rarely and the staleness window
// is acceptable. If we ever need fresher data, swap to a Realtime sub
// on the operators row.

import { useEffect, useState } from 'react';
import { supabase } from './client';
import type { BidderFeatures, BidderTier } from '@auction-platform/shared/features';

type Resolved = { flags: BidderFeatures; tier: BidderTier };

const cache = new Map<string, Resolved>();
const inflight = new Map<string, Promise<Resolved | null>>();

async function fetchOnce(operatorId: string): Promise<Resolved | null> {
  if (cache.has(operatorId)) return cache.get(operatorId)!;
  const existing = inflight.get(operatorId);
  if (existing) return existing;

  const promise = (async (): Promise<Resolved | null> => {
    const { data: op, error } = await supabase
      .from('operators')
      .select('bidder_features')
      .eq('id', operatorId)
      .maybeSingle();
    if (error || !op) {
      inflight.delete(operatorId);
      return null;
    }

    const { data: u } = await supabase.auth.getUser();
    let tier: BidderTier = 'free';
    if (u.user) {
      const { data: sub } = await supabase
        .from('bidder_subscriptions')
        .select('status')
        .eq('bidder_id', u.user.id)
        .eq('operator_id', operatorId)
        .in('status', ['active', 'trialing'])
        .maybeSingle();
      if (sub) tier = 'pro';
    }

    const resolved: Resolved = {
      flags: (op.bidder_features ?? {}) as BidderFeatures,
      tier,
    };
    cache.set(operatorId, resolved);
    inflight.delete(operatorId);
    return resolved;
  })();
  inflight.set(operatorId, promise);
  return promise;
}

export function useOperatorFeatures(operatorId: string | null): Resolved | null {
  const [data, setData] = useState<Resolved | null>(
    operatorId ? cache.get(operatorId) ?? null : null,
  );

  useEffect(() => {
    if (!operatorId) {
      setData(null);
      return;
    }
    let cancelled = false;
    fetchOnce(operatorId).then((res) => {
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
  }, [operatorId]);

  return data;
}
