// LiveBidTicker — recent-bids feed, scoped to a single lot.
//
// Activates only when the lot enters the closing window (heat 'closing'
// or 'urgent'). Outside that window we show nothing — no Realtime cost,
// no visual noise. Drives the "fight is on" feeling described in the
// product brief.
//
// Data: get_lot_recent_bids RPC returns redacted rows with a 4-char
// anon hash per bidder, plus is_you so we can highlight your own bids.
// We refetch on every Realtime UPDATE the parent passes us via the
// lastBidTickAt prop — instead of subscribing to bids.INSERT here, we
// piggyback on the lot row's UPDATE channel that the parent already
// owns. One subscription per screen, simpler cleanup.

import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';

type TickerRow = {
  bidder_anon: string;
  amount_cents: number;
  placed_at: string;
  is_you: boolean;
};

export function LiveBidTicker({
  lotId,
  active,
  lastBidTickAt,
  now,
}: {
  lotId: string;
  active: boolean; // parent decides — false outside the closing window
  lastBidTickAt: number; // bumped by parent on every Realtime UPDATE
  now: number; // shared 1Hz clock from parent
}) {
  const [rows, setRows] = useState<TickerRow[]>([]);

  useEffect(() => {
    if (!active) {
      setRows([]);
      return;
    }
    let cancelled = false;
    supabase
      .rpc('get_lot_recent_bids', { p_lot_id: lotId, p_limit: 6 })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) return; // RPC failures shouldn't break the lot view
        setRows((data ?? []) as TickerRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [lotId, active, lastBidTickAt]);

  if (!active || rows.length === 0) return null;

  return (
    <View
      style={{
        marginTop: 16,
        padding: 12,
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          Live bids
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: colors.danger,
            }}
          />
          <Text
            style={{
              color: colors.danger,
              fontSize: 10,
              fontWeight: '900',
              letterSpacing: 0.6,
            }}
          >
            LIVE
          </Text>
        </View>
      </View>
      {rows.map((r, i) => {
        const ageMs = now - new Date(r.placed_at).getTime();
        const ageLabel =
          ageMs < 3_000
            ? 'just now'
            : ageMs < 60_000
              ? `${Math.round(ageMs / 1000)}s ago`
              : `${Math.round(ageMs / 60_000)}m ago`;
        return (
          <View
            key={`${r.placed_at}:${i}`}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingVertical: 4,
            }}
          >
            <Text
              style={{
                color: r.is_you ? colors.winning : colors.text,
                fontSize: 13,
                fontWeight: r.is_you ? '900' : '600',
              }}
            >
              {r.is_you ? 'You' : r.bidder_anon}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text
                style={{
                  color: r.is_you ? colors.winning : colors.text,
                  fontSize: 14,
                  fontWeight: '900',
                  letterSpacing: -0.3,
                }}
              >
                {formatCents(r.amount_cents)}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 11, minWidth: 60, textAlign: 'right' }}>
                {ageLabel}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
