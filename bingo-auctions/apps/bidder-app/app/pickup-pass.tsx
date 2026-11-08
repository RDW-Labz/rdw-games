// Pickup pass (native) — the app half of mig 0241.
//
// The pass shipped web-only. The app's pickup tab listed each invoice
// separately, so an app-only customer had no combined walk list and no session
// QR — the feature was unreachable from the app entirely (field report
// 2026-07-27: "doesn't even give an option like the browser").
//
// One screen for the whole warehouse visit, matching /profile/pickup-pass:
//   • ONE session QR staff scan at the counter to open every invoice at once
//   • aisle-ordered walk list across EVERY invoice (serpentine — never doubles
//     back down an aisle)
//   • tap-to-collect progress
//
// All of the session logic stays server-side (GET /api/bidder/pickup-pass).
// The membership rules and owed-lot filters have been fixed repeatedly in
// lib/pickup-session.ts; a second copy in the app would drift and re-break
// them, so this screen only renders what the server returns.

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

type PassItem = {
  lotId: string;
  lotCode: string;
  stickerCode: string | null;
  /**
   * The label physically on the box, resolved server-side (SessionItem in
   * apps/operator-web/src/lib/pickup-session.ts). Always prefer it — see
   * `displayCode` below.
   */
  displayCode: string | null;
  title: string;
  photoUrl: string | null;
  invoiceId: string;
  outcome: 'collected' | 'missing' | 'left_behind' | null;
  binCode: string | null;
  aisle: string | null;
  bay: string | null;
  pickupBy: string | null;
};

type PassInvoice = {
  id: string;
  totalCents: number;
  status: string;
  auctionTitle: string | null;
  pickupStatus: string;
  lotCount: number;
  pickupBy: string | null;
};

type PassWarehouse = { id: string; name: string; lotCount: number };

type LoadState =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      sessionUrl: string;
      items: PassItem[];
      invoices: PassInvoice[];
      warehouses: PassWarehouse[];
      activeWarehouseId: string | null;
    };

/**
 * The code the customer reads off the box.
 *
 * The server already resolved this (SessionItem.displayCode) over the lot's
 * full relist lineage; this used to re-derive it from (stickerCode, lotCode)
 * alone and so disagreed whenever the label lived on an ancestor — a relist
 * child carries no sticker of its own, so the pass printed the synthetic
 * `BIN-007904` while the box read `TEA4951993` (reported 2026-08-10). The
 * fallback stays for a stale cached payload from before the field existed.
 */
function displayCode(item: PassItem): string {
  if (item.displayCode) return item.displayCode;
  if (item.stickerCode) {
    const idx = item.stickerCode.indexOf(':');
    return idx >= 0 ? item.stickerCode.slice(idx + 1) : item.stickerCode;
  }
  return item.lotCode;
}

function fmtDeadline(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ts));
}

export default function PickupPassScreen() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [collected, setCollected] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // 0293: which building this pass is for. null = let the server pick (the one
  // with the most owed lots). A merged pass would interleave two warehouses.
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    if (!token) {
      setState({ kind: 'error', message: 'Please sign in again to see your pickup pass.' });
      setRefreshing(false);
      return;
    }

    try {
      const qs = warehouseId ? `?warehouse=${encodeURIComponent(warehouseId)}` : '';
      const res = await fetch(`${API_BASE}/api/bidder/pickup-pass${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        ok?: boolean;
        enabled?: boolean;
        sessionUrl?: string;
        collectedLotIds?: string[];
        items?: PassItem[];
        invoices?: PassInvoice[];
        warehouses?: PassWarehouse[];
        activeWarehouseId?: string | null;
        error?: string;
      };

      if (!res.ok || !body.ok) {
        setState({
          kind: 'error',
          message:
            body.error === 'contents_load_failed' || body.error === 'session_unavailable'
              ? "We couldn't load your pickup pass just now. Please try again in a minute — your won items are safe and still on your invoices."
              : 'Please sign in again to see your pickup pass.',
        });
        setRefreshing(false);
        return;
      }

      if (!body.enabled) {
        setState({ kind: 'disabled' });
        setRefreshing(false);
        return;
      }

      setCollected(new Set(body.collectedLotIds ?? []));
      setState({
        kind: 'ready',
        sessionUrl: body.sessionUrl ?? '',
        items: body.items ?? [],
        invoices: body.invoices ?? [],
        warehouses: body.warehouses ?? [],
        activeWarehouseId: body.activeWarehouseId ?? null,
      });
    } catch {
      setState({
        kind: 'error',
        message: 'No connection. Your pickup pass needs the network to load — try again in a moment.',
      });
    }
    setRefreshing(false);
  }, [warehouseId]);

  // Staff resolve items at the counter while this screen is open, so keep it
  // fresh the same way the pickup tab does: on focus, on app resume, and a
  // light poll while visible.
  useFocusEffect(
    useCallback(() => {
      load();
      const sub = AppState.addEventListener('change', (st) => {
        if (st === 'active') load();
      });
      const poll = setInterval(load, 30_000);
      return () => {
        sub.remove();
        clearInterval(poll);
      };
    }, [load]),
  );

  const toggle = useCallback(
    async (lotId: string) => {
      const wasCollected = collected.has(lotId);
      // Optimistic — this is per-visit scratch state, nothing downstream
      // depends on it (staff verification at the counter is authoritative).
      setCollected((prev) => {
        const next = new Set(prev);
        if (wasCollected) next.delete(lotId);
        else next.add(lotId);
        return next;
      });
      setSaving((prev) => new Set(prev).add(lotId));

      try {
        const { data: s } = await supabase.auth.getSession();
        const token = s.session?.access_token;
        if (!token) throw new Error('no_token');
        const res = await fetch(`${API_BASE}/api/bidder/pickup-pass`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: wasCollected ? 'uncollect' : 'collect', lot_id: lotId }),
        });
        if (!res.ok) throw new Error('save_failed');
      } catch {
        // Roll back so the checkbox never lies about what the server has.
        setCollected((prev) => {
          const next = new Set(prev);
          if (wasCollected) next.add(lotId);
          else next.delete(lotId);
          return next;
        });
      } finally {
        setSaving((prev) => {
          const next = new Set(prev);
          next.delete(lotId);
          return next;
        });
      }
    },
    [collected],
  );

  if (state.kind === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  if (state.kind === 'disabled') {
    return (
      <Shell>
        <Text style={h1}>Pickup pass</Text>
        <Text style={body}>
          The pickup pass isn&apos;t available yet — for now, open each order from the
          Pickup tab and use its QR code. It&apos;s coming soon!
        </Text>
      </Shell>
    );
  }

  if (state.kind === 'error') {
    return (
      <Shell>
        <Text style={h1}>Pickup pass</Text>
        <Text style={[body, { color: '#f87171' }]}>{state.message}</Text>
        <Pressable onPress={() => { setState({ kind: 'loading' }); load(); }} style={btn}>
          <Text style={btnText}>Try again</Text>
        </Pressable>
      </Shell>
    );
  }

  if (state.invoices.length === 0) {
    return (
      <Shell>
        <Text style={h1}>Pickup pass</Text>
        <Text style={body}>
          Nothing to pick up right now. Win something and it&apos;ll show up here with a
          walking route and your checkout QR code.
        </Text>
        {/* The browse tab is (tabs)/index — "/(tabs)/browse" is not a route. */}
        <Link href="/(tabs)" asChild>
          <Pressable style={btn}>
            <Text style={btnText}>Browse live auctions</Text>
          </Pressable>
        </Link>
      </Shell>
    );
  }

  const remaining = state.items.filter((i) => !collected.has(i.lotId)).length;
  const totalCents = state.invoices.reduce((sum, i) => sum + i.totalCents, 0);
  // Group the (already serpentine-ordered) items by aisle without re-sorting —
  // the server owns walk order.
  const groups: Array<{ aisle: string; items: PassItem[] }> = [];
  for (const item of state.items) {
    const label = item.aisle ? `Aisle ${item.aisle}` : 'Ask at the counter';
    const last = groups[groups.length - 1];
    if (last && last.aisle === label) last.items.push(item);
    else groups.push({ aisle: label, items: [item] });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor="#8a93a6"
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Text style={h1}>Pickup pass</Text>

      {/* 0293: location switcher — only when the bidder owes at >1 building.
          Harrison (AR) and Dodge City (KS) are ~400 miles apart; a merged pass
          would interleave both into one walk route behind one counter QR. */}
      {state.warehouses.length > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {state.warehouses.map((w) => {
            const active = w.id === state.activeWarehouseId;
            return (
              <Pressable
                key={w.id}
                onPress={() => setWarehouseId(w.id)}
                style={{
                  paddingVertical: 7,
                  paddingHorizontal: 13,
                  borderRadius: 999,
                  backgroundColor: active ? '#4f8cff' : '#151925',
                  borderWidth: 1,
                  borderColor: active ? '#4f8cff' : '#232839',
                }}
              >
                <Text
                  style={{
                    color: active ? '#fff' : '#8a93a6',
                    fontSize: 13,
                    fontWeight: '700',
                  }}
                >
                  {w.name} ({w.lotCount})
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={[body, { marginBottom: 16 }]}>
        {state.items.length} item{state.items.length === 1 ? '' : 's'} across{' '}
        {state.invoices.length} order{state.invoices.length === 1 ? '' : 's'} ·{' '}
        {formatCents(totalCents)}
      </Text>

      {/* ONE QR for the whole visit — the thing the app was missing. */}
      <View
        style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          padding: 20,
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        {state.sessionUrl ? <QRCode value={state.sessionUrl} size={200} /> : null}
        <Text style={{ color: '#0b0d12', fontSize: 13, fontWeight: '700', marginTop: 14 }}>
          Show this at the counter
        </Text>
        <Text style={{ color: '#46505f', fontSize: 12, textAlign: 'center', marginTop: 4 }}>
          One scan opens all {state.invoices.length} of your orders.
        </Text>
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingVertical: 12,
          paddingHorizontal: 14,
          backgroundColor: '#151925',
          borderRadius: 10,
          marginBottom: 20,
        }}
      >
        <Text style={{ color: '#8a93a6', fontSize: 13 }}>Still to collect</Text>
        <Text style={{ color: remaining === 0 ? '#4ade80' : '#e8eaf0', fontSize: 13, fontWeight: '700' }}>
          {remaining === 0 ? 'All collected ✓' : `${remaining} of ${state.items.length}`}
        </Text>
      </View>

      <Text style={sectionH}>Your walking route</Text>
      <Text style={[body, { fontSize: 12, marginBottom: 12 }]}>
        Ordered so you never double back down an aisle. Tap an item once you have it.
      </Text>

      {groups.map((group) => (
        <View key={group.aisle} style={{ marginBottom: 18 }}>
          <Text
            style={{
              color: '#8a93a6',
              fontSize: 12,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 6,
            }}
          >
            {group.aisle}
          </Text>
          {group.items.map((item) => {
            const done = collected.has(item.lotId);
            const busy = saving.has(item.lotId);
            const deadline = fmtDeadline(item.pickupBy);
            return (
              <Pressable
                key={item.lotId}
                onPress={() => toggle(item.lotId)}
                disabled={busy}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  backgroundColor: done ? '#12241a' : '#151925',
                  borderWidth: 1,
                  borderColor: done ? '#245c37' : '#232839',
                  marginBottom: 8,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: done ? '#4ade80' : '#3a4155',
                    backgroundColor: done ? '#4ade80' : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {done ? <Text style={{ color: '#0b0d12', fontSize: 14, fontWeight: '900' }}>✓</Text> : null}
                </View>

                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    numberOfLines={2}
                    style={{
                      color: done ? '#8a93a6' : '#e8eaf0',
                      fontSize: 14,
                      fontWeight: '600',
                      textDecorationLine: done ? 'line-through' : 'none',
                    }}
                  >
                    {item.title}
                  </Text>
                  <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
                    {item.binCode ? `Bin ${item.binCode}` : 'Location at counter'} · {displayCode(item)}
                  </Text>
                  <Text style={{ color: '#8a93a6', fontSize: 11, marginTop: 2 }}>
                    Invoice {item.invoiceId.slice(0, 8)}
                  </Text>
                  {/* Tap-through to the original listing (request 2026-07-29):
                      the box/packaging photo is what makes a hard-to-find item
                      findable on the shelf. A nested Link rather than reusing
                      the row press, which is the collected toggle — tapping to
                      look at photos must not tick the item off. */}
                  <Link
                    href={`/lot/${item.lotId}`}
                    onPress={(e) => e.stopPropagation()}
                    style={{ marginTop: 4 }}
                  >
                    <Text style={{ color: '#f6911e', fontSize: 12, fontWeight: '700' }}>
                      View original photos →
                    </Text>
                  </Link>
                  {item.outcome === 'left_behind' ? (
                    <Text style={{ color: '#fbbf24', fontSize: 11, marginTop: 2 }}>
                      Left behind last visit — still yours
                    </Text>
                  ) : null}
                  {deadline ? (
                    <Text style={{ color: '#8a93a6', fontSize: 11, marginTop: 2 }}>
                      Pick up by {deadline}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}

      <Text style={sectionH}>Orders on this pass</Text>
      {state.invoices.map((inv) => (
        <Link key={inv.id} href={{ pathname: '/pickup/[id]', params: { id: inv.id } }} asChild>
          <Pressable
            style={{
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: '#232839',
            }}
          >
            <Text style={{ color: '#e8eaf0', fontSize: 14, fontWeight: '600' }}>
              {inv.auctionTitle ?? 'Auction'}
            </Text>
            <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
              {inv.lotCount} item{inv.lotCount === 1 ? '' : 's'} · {formatCents(inv.totalCents)}
              {inv.status === 'partially_refunded' ? ' · partially refunded' : ''}
            </Text>
            <Text style={{ color: '#4f8cff', fontSize: 12, marginTop: 4 }}>View order details →</Text>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, gap: 14 }}>{children}</View>
  );
}

const h1 = { color: '#e8eaf0', fontSize: 24, fontWeight: '900' as const, letterSpacing: -0.5 };
const body = { color: '#8a93a6', fontSize: 14, lineHeight: 21 };
const sectionH = {
  color: '#8a93a6',
  fontSize: 12,
  fontWeight: '700' as const,
  textTransform: 'uppercase' as const,
  letterSpacing: 0.5,
  marginBottom: 4,
};
const btn = {
  backgroundColor: '#4f8cff',
  paddingVertical: 12,
  paddingHorizontal: 20,
  borderRadius: 8,
  alignSelf: 'flex-start' as const,
  marginTop: 8,
};
const btnText = { color: '#fff', fontSize: 14, fontWeight: '700' as const };
