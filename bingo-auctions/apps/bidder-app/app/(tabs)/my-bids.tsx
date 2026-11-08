// My bids — every lot the bidder has ever placed a manual bid on,
// classified into four buckets:
//   leading — auction still live, bidder is currently the high bidder
//   outbid  — auction still live, someone else is the high bidder
//   won     — auction closed (or past close_at) and the bidder won
//   lost    — auction closed and someone else won
//
// Why filter is_auto=false: place_bid inserts the bidder's manual
// row as is_auto=false plus a possible proxy auto row (is_auto=true)
// that belongs to the OTHER bidder being raised. Keeping our query
// to manual bids is the right scope. (Her own auto rows are read only
// to correct "Your max" on open lots — see withEffectiveMax.)
//
// Why effective-close: in dev (and during the brief window after
// close_at passes in prod), the closeLot worker may not have flipped
// status yet. We treat past-close lots as effectively closed so the
// bidder doesn't have to wait for a worker tick to see "you won."

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Link, useRouter, useFocusEffect } from 'expo-router';
import { supabase, getCurrentUserId } from '@auction-platform/supabase-client';
import {
  formatCents,
  lotDisplayCode,
  describeAutoRaise,
  autoRaiseMessage,
  type AutoRaiseStatus,
} from '@auction-platform/shared';
import { colors, formatCountdown, heatFromCloseAt, heatColor } from '@auction-platform/design-system';
import { ACTIVE_LOT_STATUSES, mergeLatestBidPerLot, withEffectiveMax } from '../../lib/my-bids-merge';
import {
  chunkIds,
  createLoadSequencer,
  createReloadDebouncer,
  lotSetKey,
  shouldReloadForEvent,
} from '../../lib/my-bids-realtime';

type BidRow = {
  lot_id: string;
  amount_cents: number;
  max_amount_cents: number;
  placed_at: string;
  lot: {
    id: string;
    lot_code: string;
    sticker_code: string | null;
    display_code: string | null;
    title: string;
    status: string;
    current_bid_cents: number | null;
    close_at: string;
    winner_bidder_id: string | null;
    auction_id: string | null;
    photo_urls: string[] | null;
  } | null;
};

const LOT_COLUMNS =
  'id, lot_code, sticker_code, display_code, title, status, current_bid_cents, close_at, winner_bidder_id, auction_id, photo_urls';

// PostgREST caps every response at max-rows (1000, supabase/config.toml), so
// the open-lot read pages until a short page. A bidder's manual bids on open
// lots are normally dozens; ACTIVE_MAX_PAGES bounds the worst case, since
// load() re-runs on live updates to her lots while this tab is focused.
const ACTIVE_PAGE_SIZE = 1000;
const ACTIVE_MAX_PAGES = 5;

// Every manual bid the bidder has on a lot that is still open, newest first.
// `!inner` + the embedded status filter turns the lot embed into a join, so
// bids on closed lots aren't returned at all (not returned with lot = null).
// RLS (lots_bidder_read_published, mig 0181) shows bidders scheduled/live
// lots, so the filter hides nothing the plain embed would have shown.
// Fail-safe: any error returns what was read so far — worst case the screen
// falls back to the 200-row history alone (the pre-2026-09-26 behavior).
async function fetchActiveLotBids(uid: string): Promise<BidRow[]> {
  const rows: BidRow[] = [];
  try {
    for (let page = 0; page < ACTIVE_MAX_PAGES; page++) {
      const from = page * ACTIVE_PAGE_SIZE;
      const { data, error } = await supabase
        .from('bids')
        .select(`lot_id, amount_cents, max_amount_cents, placed_at, lots!lot_id!inner(${LOT_COLUMNS})`)
        .eq('bidder_id', uid)
        .eq('is_auto', false)
        .in('lots.status', ACTIVE_LOT_STATUSES as unknown as string[])
        .order('placed_at', { ascending: false })
        .range(from, from + ACTIVE_PAGE_SIZE - 1);
      if (error || !data) break;
      // Unaliased embed (so the `lots.status` filter path is unambiguous) —
      // rename to the `lot` key the rest of the screen reads.
      for (const r of data as unknown as Array<Omit<BidRow, 'lot'> & { lots: BidRow['lot'] }>) {
        const { lots, ...bid } = r;
        rows.push({ ...bid, lot: lots });
      }
      if (data.length < ACTIVE_PAGE_SIZE) break;
    }
  } catch {
    /* fail-safe: history-only */
  }
  return rows;
}

type Tone = 'leading' | 'outbid' | 'won' | 'lost';
type Tab = 'all' | Tone;

// Sort priority for the 'all' tab — urgent first, then live wins, then
// historical results. Urgency drives the eye to the action that matters.
const TONE_SORT_RANK: Record<Tone, number> = {
  outbid: 0,
  leading: 1,
  won: 2,
  lost: 3,
};

const TONE_COLOR: Record<Tone, string> = {
  leading: colors.winning,
  outbid: colors.danger,
  won: colors.success,
  lost: colors.textDim,
};
// TONE_LABEL is referenced from the tone chip rendering below in a
// dynamic [tone] lookup. Kept for future explicit per-tone display; if
// it stays unused for another iteration, remove on the next sweep.
const _TONE_LABEL: Record<Tone, string> = {
  leading: 'Leading',
  outbid: 'Outbid',
  won: 'Won',
  lost: 'Lost',
};
void _TONE_LABEL;

// Invoice statuses where the bidder still owes money. mig 0077 introduced
// unpaid_no_show + payment_failed_relisted; mig 0104 introduced
// payment_failed_grace. Surfaced as a red banner above the My Bids list
// per user report 2026-06-01 ("can not find where to pay for that unpaid
// invoice"). Card-declined pushes fire (mig 0077 payment_followups), but
// without an in-app entry-point the bidder has no way to discover the
// retry-pay flow once the push notification is dismissed.
const UNPAID_STATUSES = [
  'payment_failed_grace',
  'payment_failed_relisted',
  'unpaid_no_show',
] as const;

export default function MyBidsScreen() {
  const router = useRouter();
  const [bidder, setBidder] = useState<string | null>(null);
  const [bids, setBids] = useState<BidRow[]>([]);
  // lot_id -> payment/pickup status, so won rows show "Paid · Awaiting pickup"
  // (not "Tap to pay") and picked-up items drop off the list. Empty = today's behavior.
  const [lotPay, setLotPay] = useState<Record<string, { paid: boolean; pickedUp: boolean }>>({});
  // BID-CONFIRM (2026-10): per-lot "was my current bid an auto-raise?" —
  // only computed for open lots (same set withEffectiveMax already widens
  // to auto rows for). lot_id -> status; absent = no auto-raise to show.
  const [autoRaiseByLot, setAutoRaiseByLot] = useState<Record<string, AutoRaiseStatus>>({});
  const [unpaidCount, setUnpaidCount] = useState(0);
  // Holds the single unpaid invoice id when count === 1 so the banner
  // can route directly to /invoice/[id] instead of the list.
  const [singleUnpaidId, setSingleUnpaidId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [error, setError] = useState<string | null>(null);

  const openInvoiceForAuction = useCallback(
    async (auctionId: string) => {
      const uid = await getCurrentUserId();
      if (!uid) return;
      const { data } = await supabase
        .from('invoices')
        .select('id')
        .eq('auction_id', auctionId)
        .eq('bidder_id', uid)
        .maybeSingle();
      if (data?.id) {
        router.push({ pathname: '/invoice/[id]', params: { id: data.id as string } });
      } else {
        Alert.alert(
          'Invoice still being prepared',
          "Your invoice should be ready shortly. Pull to refresh in a minute.",
        );
      }
    },
    [router],
  );

  // Every setState below runs only while its load is still the latest
  // (lib/my-bids-realtime.ts) — a slow older load can't overwrite a newer one.
  const loadSeq = useRef(createLoadSequencer()).current;

  const load = useCallback(async () => {
    const isLatest = loadSeq.begin();
    setError(null);
    const uid = await getCurrentUserId();
    if (!isLatest()) return;
    if (!uid) {
      setBids([]);
      setUnpaidCount(0);
      setSingleUnpaidId(null);
      setAutoRaiseByLot({});
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setBidder(uid);

    // Fetch unpaid invoices for the banner. We select id + status (not just
    // a count) so we can route the banner directly to /invoice/[id] when
    // there's exactly one unpaid invoice — making the pay path one tap
    // instead of two. Failures here are non-fatal — we just suppress the
    // banner rather than blocking the My Bids list. Limit 11 so we can
    // distinguish "exactly 1" from ">1" without fetching unbounded rows.
    void (async () => {
      const { data: unpaidRows, error: cErr } = await supabase
        .from('invoices')
        .select('id')
        .eq('bidder_id', uid)
        .in('status', UNPAID_STATUSES as unknown as string[])
        .limit(11);
      if (!cErr && unpaidRows && isLatest()) {
        setUnpaidCount(unpaidRows.length);
        setSingleUnpaidId(unpaidRows.length === 1 ? ((unpaidRows[0]?.id as string) ?? null) : null);
      }
    })();
    // The `lots` table has a `current_bid_id` FK pointing at `bids`,
    // and `bids.lot_id` points at `lots` — a cyclic relationship.
    // PostgREST refuses to pick a default, so we disambiguate by naming
    // the FK column (`!lot_id`) on the embed.
    //
    // Two reads, merged below: the latest 200 bid rows (history), and every
    // bid on a still-open lot (so a live lot never falls off the 200-row cap
    // for a heavy bidder — see lib/my-bids-merge.ts).
    const [{ data, error: qErr }, active] = await Promise.all([
      supabase
        .from('bids')
        .select(`lot_id, amount_cents, max_amount_cents, placed_at, lot:lots!lot_id(${LOT_COLUMNS})`)
        .eq('bidder_id', uid)
        .eq('is_auto', false)
        .order('placed_at', { ascending: false })
        .limit(200),
      fetchActiveLotBids(uid),
    ]);
    if (!isLatest()) return;
    if (qErr) {
      setError(qErr.message);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const out = mergeLatestBidPerLot((data ?? []) as unknown as BidRow[], active);
    setBids(out);

    // "Your max" on open lots: a self-raise can land on her auto (defending)
    // row, leaving the manual row we show with a stale max — take the greatest
    // across her auto rows too (lib/my-bids-merge.ts). Display only; fail-safe
    // — any error keeps the manual row's value.
    //
    // BID-CONFIRM (2026-10): the same read also answers "was my CURRENT bid
    // on this lot an auto-raise?" — amount_cents + placed_at (added to the
    // select below) feed describeAutoRaise alongside the manual representative
    // row already in `out`, so no second query is needed for that.
    try {
      const openRows = out.filter(
        (r) => r.lot && (ACTIVE_LOT_STATUSES as readonly string[]).includes(r.lot.status),
      );
      const openIds = openRows.map((r) => r.lot_id);
      if (openIds.length) {
        const { data: autoRows, error: aErr } = await supabase
          .from('bids')
          .select('lot_id, amount_cents, max_amount_cents, placed_at')
          .eq('bidder_id', uid)
          .eq('is_auto', true)
          .in('lot_id', openIds)
          .order('max_amount_cents', { ascending: false })
          .limit(1000);
        if (!aErr && autoRows?.length && isLatest()) {
          const auto = autoRows as Array<{
            lot_id: string;
            amount_cents: number;
            max_amount_cents: number;
            placed_at: string;
          }>;
          setBids(withEffectiveMax(out, auto));

          const autoByLotId = new Map<string, typeof auto>();
          for (const row of auto) {
            const list = autoByLotId.get(row.lot_id) ?? [];
            list.push(row);
            autoByLotId.set(row.lot_id, list);
          }
          const nextAutoRaiseByLot: Record<string, AutoRaiseStatus> = {};
          for (const r of openRows) {
            const autos = autoByLotId.get(r.lot_id) ?? [];
            nextAutoRaiseByLot[r.lot_id] = describeAutoRaise([
              {
                amount_cents: r.amount_cents,
                max_amount_cents: r.max_amount_cents,
                is_auto: false,
                placed_at: r.placed_at,
              },
              ...autos.map((a) => ({ ...a, is_auto: true as const })),
            ]);
          }
          setAutoRaiseByLot(nextAutoRaiseByLot);
        }
      }
    } catch {
      /* fail-safe: keep the manual row's max, no auto-raise line */
    }

    // Per-lot payment + pickup status (#2/#3): won rows show "Paid · Awaiting
    // pickup" instead of "Tap to pay", and picked-up items drop off the list.
    // Fail-safe — any error leaves the map empty → today's behavior.
    try {
      // Open lots have no invoice yet — skip them to keep the id list (a URL
      // query param) no longer than the 200-row history it was sized for.
      const lotIds = out
        .filter((r) => !r.lot || !(ACTIVE_LOT_STATUSES as readonly string[]).includes(r.lot.status))
        .map((r) => r.lot_id);
      if (lotIds.length) {
        const { data: il } = await supabase
          .from('invoice_lots')
          .select('lot_id, invoices!inner(status, bidder_id, pickups(status))')
          .eq('invoices.bidder_id', uid)
          .in('lot_id', lotIds);
        const rows = (il ?? []) as unknown as Array<{
          lot_id: string;
          invoices: {
            status: string | null;
            pickups: Array<{ status: string | null }> | { status: string | null } | null;
          } | null;
        }>;
        const map: Record<string, { paid: boolean; pickedUp: boolean }> = {};
        for (const r of rows) {
          const inv = r.invoices;
          if (!inv) continue;
          const paid = inv.status === 'paid' || inv.status === 'partially_refunded';
          const pk = Array.isArray(inv.pickups) ? inv.pickups[0] : inv.pickups;
          map[r.lot_id] = { paid, pickedUp: pk?.status === 'completed' };
        }
        if (isLatest()) setLotPay(map);
      } else if (isLatest()) {
        setLotPay({});
      }
    } catch {
      /* fail-safe: keep current behavior */
    }

    if (!isLatest()) return;
    setLoading(false);
    setRefreshing(false);
  }, [loadSeq]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Live updates while the screen is focused — only for lots she has bid on
  // (owner, 2026-09-26: never reload on every bid on the platform). Realtime
  // applies RLS per subscriber, so a `bids` listener only ever hears her own
  // rows; being outbid shows up as a `lots` UPDATE (price / winner), so we
  // also listen to her open lots by id, ≤100 per `in` filter. See
  // lib/my-bids-realtime.ts.
  const lotIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    lotIdsRef.current = new Set(bids.map((b) => b.lot_id));
  }, [bids]);
  // String key so the channel is rebuilt only when the SET of open lots
  // changes, not on every setBids.
  const openLotKey = useMemo(
    () =>
      lotSetKey(
        bids
          .filter((b) => b.lot && (ACTIVE_LOT_STATUSES as readonly string[]).includes(b.lot.status))
          .map((b) => b.lot_id),
      ),
    [bids],
  );

  // Realtime-triggered reloads are debounced: 1.5s after the last event, but
  // never more than 5s after the first pending one, so a closing-time bidding
  // stream still refreshes (lib/my-bids-realtime.ts). Focus and
  // pull-to-refresh call load() directly.
  const loadRef = useRef(load);
  loadRef.current = load;
  const reloadDebouncer = useRef(createReloadDebouncer(() => loadRef.current())).current;
  const scheduleReload = reloadDebouncer.schedule;
  const channelSeq = useRef(0);
  // Drop a pending reload on blur only — a channel rebuild must not swallow
  // an event that arrived while the previous reload was in flight.
  useFocusEffect(useCallback(() => () => reloadDebouncer.cancel(), [reloadDebouncer]));

  useFocusEffect(
    useCallback(() => {
      if (!bidder) return;
      const onChange = (table: 'bids' | 'lots') => (payload: { new: Record<string, unknown> }) => {
        if (shouldReloadForEvent({ table, record: payload.new ?? {} }, bidder, lotIdsRef.current)) {
          scheduleReload();
        }
      };
      // Unique topic per build: supabase.channel() hands back an existing
      // channel with the same topic, and the one just removed is still
      // closing — adding .on() to it after subscribe() throws.
      let channel = supabase
        .channel(`my-bids:${bidder}:${++channelSeq.current}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'bids', filter: `bidder_id=eq.${bidder}` },
          onChange('bids'),
        );
      const openIds = openLotKey ? openLotKey.split(',') : [];
      for (const ids of chunkIds(openIds)) {
        channel = channel.on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'lots', filter: `id=in.(${ids.join(',')})` },
          onChange('lots'),
        );
      }
      channel.subscribe();
      return () => {
        supabase.removeChannel(channel);
      };
    }, [bidder, openLotKey, scheduleReload]),
  );

  // 1Hz tick so live-row classification recomputes as wall-clock time
  // crosses close_at boundaries. Without this, a lot that was 'leading'
  // 60s ago stays labeled 'leading' until the next focus refresh, even
  // though its close_at has now passed.
  const [tick, setTick] = useState(Date.now());
  useFocusEffect(
    useCallback(() => {
      const t = setInterval(() => setTick(Date.now()), 1000);
      return () => clearInterval(t);
    }, []),
  );

  // Classify each bid into a tone bucket. Bids whose joined lot is
  // null (RLS denied, lot deleted) are kept as 'lost' so the user
  // can at least see the count and ping support — silent drops are
  // worse than a row labelled "lot unavailable."
  const classified = useMemo(() => {
    void tick; // dependency: re-run as the wall clock advances
    const nowMs = Date.now();
    return bids
      .map((b) => {
        const lot = b.lot;
        let tone: Tone;
        if (!lot) {
          tone = 'lost';
        } else {
          const pastClose = new Date(lot.close_at).getTime() <= nowMs;
          const finalized = lot.status === 'won' || lot.status === 'unsold';
          const closed = finalized || pastClose;
          if (closed) tone = lot.winner_bidder_id === bidder ? 'won' : 'lost';
          else tone = lot.winner_bidder_id === bidder ? 'leading' : 'outbid';
        }
        const pay = lotPay[b.lot_id];
        return { row: b, tone, paid: pay?.paid ?? false, pickedUp: pay?.pickedUp ?? false };
      })
      // #3: drop items already picked up — they live in the Pickup tab's
      // Completed section. pickedUp is only true when lotPay confirms it, so a
      // failed/empty lookup never hides a row.
      .filter((x) => !x.pickedUp);
  }, [bids, bidder, tick, lotPay]);

  const counts: Record<Tone, number> = useMemo(() => {
    const c = { leading: 0, outbid: 0, won: 0, lost: 0 };
    for (const x of classified) c[x.tone]++;
    return c;
  }, [classified]);

  const visibleBids = useMemo(() => {
    if (tab === 'all') {
      // Default 'all' view: sort by urgency (outbid > leading > won >
      // lost) so the action-needed rows surface above historical results.
      // Within a tone, preserve placed_at order from the server.
      return [...classified].sort(
        (a, b) => TONE_SORT_RANK[a.tone] - TONE_SORT_RANK[b.tone],
      );
    }
    return classified.filter((x) => x.tone === tab);
  }, [classified, tab]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Unpaid-invoice banner — red CTA that routes to the invoices list
          where retry-pay lives. Hidden when there are no unpaid invoices.
          The /profile/invoices screen filters statuses identical to
          UNPAID_STATUSES above. */}
      {unpaidCount > 0 && (
        <Pressable
          onPress={() => {
            // Route directly to the single invoice when there's exactly one
            // so the bidder lands on the Update-card + Retry CTAs in one tap.
            // With >1 unpaid, the list screen lets them choose which to pay.
            if (singleUnpaidId) {
              router.push({ pathname: '/invoice/[id]', params: { id: singleUnpaidId } });
            } else {
              router.push('/profile/invoices' as never);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={`${unpaidCount} unpaid invoice${unpaidCount === 1 ? '' : 's'} — tap to pay`}
          style={({ pressed }) => ({
            margin: 12,
            marginBottom: 0,
            padding: 12,
            borderRadius: 10,
            backgroundColor: colors.danger,
            opacity: pressed ? 0.85 : 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            minHeight: 48,
          })}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: '#fff',
                fontSize: 14,
                fontWeight: '900',
                letterSpacing: 0.3,
              }}
            >
              {unpaidCount} unpaid invoice{unpaidCount === 1 ? '' : 's'} — tap to pay
            </Text>
            <Text style={{ color: '#fff', fontSize: 12, marginTop: 2, opacity: 0.92 }}>
              Update your card and retry payment to avoid relisting.
            </Text>
          </View>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>›</Text>
        </Pressable>
      )}

      {/* Stat strip at top — answers "where are my wins?" at a glance */}
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <TabPill
            label="All"
            count={classified.length}
            active={tab === 'all'}
            color={colors.text}
            onPress={() => setTab('all')}
          />
          <TabPill
            label="Won"
            count={counts.won}
            active={tab === 'won'}
            color={colors.success}
            highlight={counts.won > 0}
            onPress={() => setTab('won')}
          />
          <TabPill
            label="Leading"
            count={counts.leading}
            active={tab === 'leading'}
            color={colors.winning}
            onPress={() => setTab('leading')}
          />
          <TabPill
            label="Outbid"
            count={counts.outbid}
            active={tab === 'outbid'}
            color={colors.danger}
            onPress={() => setTab('outbid')}
          />
          <TabPill
            label="Lost"
            count={counts.lost}
            active={tab === 'lost'}
            color={colors.textDim}
            onPress={() => setTab('lost')}
          />
        </ScrollView>
      </View>

      {error && (
        <View
          style={{
            margin: 12,
            padding: 10,
            backgroundColor: colors.dangerDim,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.danger,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '700' }}>
            Couldn&apos;t load bids
          </Text>
          <Text style={{ color: colors.text, fontSize: 12, marginTop: 4 }}>{error}</Text>
        </View>
      )}

      <FlatList
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textMuted}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        data={visibleBids}
        keyExtractor={(item) => item.row.lot_id}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 32 }}
        renderItem={({ item }) => (
          <BidRowView
            tone={item.tone}
            row={item.row}
            paid={item.paid}
            onOpenInvoice={openInvoiceForAuction}
            autoRaise={autoRaiseByLot[item.row.lot_id]}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center', gap: 16 }}>
            <Image
              source={
                tab === 'won'
                  ? require('../../assets/art/empty-wins.png')
                  : require('../../assets/art/empty-bids.png')
              }
              style={{ width: 220, height: 165, borderRadius: 12 }}
              contentFit="cover"
            />
            <Text style={{ color: colors.textMuted, textAlign: 'center', lineHeight: 20 }}>
              {classified.length === 0
                ? "You haven't bid on anything yet. Find a lot in Browse and place a bid."
                : tab === 'won'
                  ? 'No wins yet. Lots you win show up here once their auctions close.'
                  : tab === 'leading'
                    ? 'No live lots where you’re the high bidder right now.'
                    : tab === 'outbid'
                      ? "No live lots where you've been outbid right now."
                      : 'No lost bids yet.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

// Top-of-screen filter pill. Highlight=true draws extra attention
// (used for the Won pill when there's a count, so the user's wins
// are visible on first tap into the tab).
function TabPill({
  label,
  count,
  active,
  color,
  highlight,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  color: string;
  highlight?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: active || highlight ? 2 : 1,
        borderColor: active ? color : highlight ? color : colors.border,
        backgroundColor: active ? color + '22' : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text
        style={{
          color: active ? color : colors.textMuted,
          fontSize: 12,
          fontWeight: '900',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 1,
          backgroundColor: count > 0 ? color : colors.surfaceHi,
          borderRadius: 999,
          minWidth: 20,
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            color: count > 0 ? '#000' : colors.textMuted,
            fontSize: 11,
            fontWeight: '900',
          }}
        >
          {count}
        </Text>
      </View>
    </Pressable>
  );
}

function BidRowView({
  tone,
  row,
  paid,
  onOpenInvoice,
  autoRaise,
}: {
  tone: Tone;
  row: BidRow;
  paid: boolean;
  onOpenInvoice: (auctionId: string) => void;
  /** BID-CONFIRM: set only for open lots (load()'s openRows); undefined
   *  elsewhere, which autoRaiseMessage treats the same as "nothing to say". */
  autoRaise?: AutoRaiseStatus;
}) {
  const stampScale = useRef(new Animated.Value(0)).current;
  const stampRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (tone !== 'won') return;
    stampScale.setValue(0);
    stampRotate.setValue(0);
    Animated.parallel([
      Animated.spring(stampScale, {
        toValue: 1,
        friction: 4,
        tension: 60,
        useNativeDriver: true,
      }),
      Animated.timing(stampRotate, {
        toValue: 1,
        duration: 380,
        useNativeDriver: true,
      }),
    ]).start();
  }, [tone, stampScale, stampRotate]);

  const accent = TONE_COLOR[tone];
  const lot = row.lot;
  const youWon = tone === 'won';
  const isLive = tone === 'leading' || tone === 'outbid';
  const titleText = lot?.title ?? '(lot unavailable)';
  const subtitleText = !lot
    ? "We can't reach this lot right now."
    : youWon
      ? paid
        ? 'Paid · Awaiting pickup'
        : `Won at ${formatCents(lot.current_bid_cents ?? 0)} · Tap to pay`
      : tone === 'lost'
        ? `Closed at ${formatCents(lot.current_bid_cents ?? 0)} · Your max ${formatCents(row.max_amount_cents)}`
        : `Your max ${formatCents(row.max_amount_cents)} · Current ${
            lot.current_bid_cents != null ? formatCents(lot.current_bid_cents) : '—'
          }`;
  // BID-CONFIRM: "We raised your bid to $X — your max is $Y" when her newest
  // row on this (open) lot was a server-placed proxy defense, not her tap.
  const autoRaiseLine = isLive && autoRaise ? autoRaiseMessage(autoRaise, formatCents) : null;

  // Countdown badge for live rows so the bidder knows urgency at a
  // glance from the My Bids list, no tap-through required.
  const countdownLabel = lot && isLive ? formatCountdown(lot.close_at) : null;
  const heatHex =
    lot && isLive ? heatColor(heatFromCloseAt(lot.close_at, lot.status)) : null;

  // Thumbnail — first photo at 44px so the row reads visually, not just
  // as text. Heavy bidders with 20+ active rows scan by photo, not title.
  const thumb = lot?.photo_urls?.[0] ?? null;

  const Body = (
    <Pressable
      onPress={youWon && lot?.auction_id ? () => onOpenInvoice(lot.auction_id!) : undefined}
      style={{
        padding: 14,
        borderRadius: 12,
        backgroundColor: youWon ? colors.successDim : colors.surface,
        borderWidth: 1,
        borderColor: youWon ? colors.success : colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View
        style={{
          width: 4,
          alignSelf: 'stretch',
          borderRadius: 2,
          backgroundColor: accent,
          opacity: youWon ? 0 : 0.9,
        }}
      />
      {thumb ? (
        <Image
          source={{ uri: thumb }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            backgroundColor: colors.surfaceAlt,
          }}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            backgroundColor: colors.surfaceAlt,
          }}
        />
      )}
      <View style={{ flex: 1 }}>
        {lot?.lot_code && (
          <Text
            style={{
              color: colors.primary,
              fontFamily: 'monospace',
              fontSize: 11,
              fontWeight: '900',
              letterSpacing: 0.4,
              marginBottom: 2,
            }}
          >
            {lotDisplayCode(lot) ?? lot.lot_code}
          </Text>
        )}
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }} numberOfLines={2}>
          {titleText}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>{subtitleText}</Text>
        {autoRaiseLine && (
          <Text
            testID="auto-raise-line"
            style={{ color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 2 }}
          >
            {autoRaiseLine}
          </Text>
        )}
      </View>
      {countdownLabel && heatHex && (
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: heatHex,
            borderRadius: 6,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              color: '#000',
              fontSize: 11,
              fontWeight: '900',
              letterSpacing: 0.4,
            }}
          >
            {countdownLabel}
          </Text>
        </View>
      )}
      {youWon && (
        <Animated.View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 6,
            backgroundColor: colors.success,
            transform: [
              { scale: stampScale },
              {
                rotate: stampRotate.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['-25deg', '-8deg'],
                }),
              },
            ],
          }}
        >
          <Text
            style={{
              color: '#000',
              fontSize: 13,
              fontWeight: '900',
              letterSpacing: 1.6,
            }}
          >
            WON
          </Text>
        </Animated.View>
      )}
    </Pressable>
  );

  // Lot detail link only when the row has a resolved lot — null lots
  // can't be navigated to.
  if (!lot) return Body;
  if (youWon) return Body; // tap handled by onPress above
  return (
    <Link
      href={{ pathname: '/lot/[id]', params: { id: lot.id, source: 'my_bids' } }}
      asChild
    >
      {Body}
    </Link>
  );
}
