// LotTR — Relot an existing item (Jared recap 2026-07-07 item 7).
//
// "Relotting should be treated differently than creating a brand-new lot."
// Staff holding a returned / unsold / refunded-back item enter the code off
// its sticker (lot code, sticker code, or the /l/<qr> URL), confirm the
// match, and this screen relists it through the SAME relist_lot_into_auction
// RPC the worklist + auto-relist cron use — fresh lot code + lot number,
// relisted_from_lot_id lineage, relist_count bump, source lot flipped to
// 'relisted'. It then lands on the new lot's detail screen (worklist/[id])
// where title, description, condition, price, and photos are all editable —
// so "new listing with updated photos and a new lot code" is one flow.
//
// Status handling:
//   unsold / in_inventory / relisted → RPC accepts directly.
//   won + refunded line item         → the item legally came back to the
//     store (refund-and-restock). We flip it to 'unsold' first, then relist.
//   won (not refunded) / live        → refused with an explanation; that
//     item belongs to a customer or a live auction.
//   refunded (mig 0475)              → manager PIN + typed name + reason,
//     through relist_refunded_lot (RefundedRelistForm). The status only exists
//     once 0475 is applied, so before then this path never shows.
//
// All JS-only — OTA updatable.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ownerPickupStatus } from '@/lib/owner-pickup-status';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Camera, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { getActiveLottingWorkerId } from '@auction-platform/domain-lotting';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { ALL_RETAIL_CODE_TYPES, firstCodeValue } from '@/lib/vision-camera';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { RefundedRelistForm } from '@/features/lotting/RefundedRelistForm';
import { isRefundedLot, REFUNDED_TAG, type RelistAfterRefundResult } from '@/lib/relist-after-refund';

// The projection `resolveLotScan` needs on top of SCAN_BASE_COLUMNS.
const RELOT_COLUMNS = 'title, photo_urls, warehouse_id, relist_count';

type RelotRow = ScanRow & {
  title: string;
  photo_urls: string[] | null;
  warehouse_id: string | null;
  relist_count: number | null;
};

type FoundLot = RelotRow & {
  refunded: boolean;
  /** Set when the scanned label was a tombstone and lineage led to this row. */
  hoppedFrom: string | null;
};

// Winning-customer context for a lot that's been sold (staff_scan_lot_owner,
// mig 0257). Surfaced when a relot is blocked on a 'won' item so a manager can
// see WHO owns it (name + permanent bidder number + invoice + fulfillment)
// without hopping to the operator console (feedback 2026-07-17).
type OwnerInfo = {
  bidder_name: string | null;
  bidder_number: number | null;
  invoice_id: string | null;
  invoice_status: string | null;
  picked_up_at: string | null;
  refunded_at: string | null;
  pickup_status: string | null;
  pickup_completed_at?: string | null;
};

export default function RelotScreen() {
  const router = useRouter();
  const role = useOperatorRole();
  // Inventory's "Refunded – relist" rows open this screen with ?code=.
  const params = useLocalSearchParams<{ code?: string }>();
  const codeFromUrl = typeof params.code === 'string' ? params.code : '';

  const [query, setQuery] = useState(codeFromUrl);
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FoundLot | null>(null);
  const [owner, setOwner] = useState<OwnerInfo | null>(null);
  const [relotting, setRelotting] = useState(false);

  // Scanning (2026-08-07): relot was type-only, so staff hand-keyed a 10-char
  // sticker code for every returned item while Lot Lookup right next door
  // scanned. Same camera stack as find.tsx / lotting.
  const [scanning, setScanning] = useState(false);
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery: stop the camera when this route is backgrounded or covered.
  const cameraGate = useCameraGate();
  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const SCAN_DEDUP_MS = 2500;

  // 0353: there is deliberately no "is there an auction to relot into?" check
  // any more. Relot lands the item in inventory, unscheduled — it never needs
  // a destination auction, so it can no longer fail for want of one. The probe
  // and its warning banner that used to live here were both removed with the
  // auto-pick they were warning about.

  const search = useCallback(
    async (rawOverride?: string) => {
      if (role.kind !== 'staff') return;
      const source = (rawOverride ?? query).trim();
      if (!source) {
        Alert.alert('Enter a code', 'Type the lot code or sticker code off the item, or paste the QR link.');
        return;
      }
      setSearching(true);
      setFound(null);
      setOwner(null);
      try {
        // Resolve through the ONE shared resolver every other staff scanner
        // uses (put-away, bin audit, pickup verify). It matches `lot_code`,
        // `sticker_code`, and `legacy_lot_code` case-insensitively, knows that
        // sticker codes are stored operator-prefixed ("OP:CODE" — migs
        // 0139/0163) so the printed label is a SUFFIX, ranks collisions, and
        // walks `relisted_from_lot_id` forward when the match is a tombstone.
        // Relot was the last screen carrying its own probe ladder; that ladder
        // was exact-match + case-sensitive, so a scanner emitting lowercase or
        // a `legacy_lot_code`-only item read as "no lot matches" here while Lot
        // Lookup found it fine. RLS scopes `lots` to the operator, so no
        // explicit operator_id filter is needed (and a stale one would only
        // narrow the result incorrectly).
        // A failed lookup and a label that matches nothing are different
        // problems with the same old symptom: "No lot matches". Capture the
        // real error so the alert below can say which one happened — staff were
        // being told to check a sticker that was never at fault.
        let queryError: string | null = null;
        const result = await resolveLotScan<RelotRow>(source, RELOT_COLUMNS, {
          onQueryError: (m) => {
            queryError = queryError ?? m;
          },
        });
        if (queryError) {
          throw new Error(`lookup_failed: ${String(queryError)}`);
        }
        if (!result) {
          // Nothing matched a BinGo identifier. The camera happily reads the
          // manufacturer's UPC off the box, and `external_code` holds those —
          // but a UPC is NOT unique to a lot (prod: 00036000385861 is on three
          // separate items). The old type-only ladder probed `external_code`
          // and let preferActiveLot pick one, which on a scanner would relot a
          // DIFFERENT physical item than the one in your hands. So look it up
          // only to explain the miss; never to auto-select.
          const { data: upc } = await supabase
            .from('lots')
            .select('lot_code, sticker_code, display_code')
            .eq('external_code', source)
            .is('deleted_at', null)
            .limit(5);
          if (upc?.length) {
            Alert.alert(
              'That looks like a product barcode',
              `"${source}" is a manufacturer UPC — it's on ${upc.length === 1 ? 'a lot' : `${upc.length} different lots`} here, so it can't say which item you're holding. Scan the BinGo sticker on the box instead${upc.length === 1 && upc[0]?.sticker_code ? ` (${upc[0].sticker_code.split(':').pop()})` : ''}.`,
            );
            return;
          }
          // Say what was actually read and what to try next. The bare "check
          // the sticker" gave staff nowhere to go when the camera had read the
          // manufacturer's barcode instead of the BinGo label — which is most
          // boxes, since only 82 of ~2,300 relot candidates carry a UPC we can
          // recognise and explain above.
          Alert.alert(
            'Not found',
            `Nothing in BinGo matches "${source}".\n\n` +
              'If you scanned a barcode, it was probably the manufacturer\'s — scan the BinGo ' +
              'sticker (BRN/TEA/PNK/GRA…) or the lot QR instead, or type the code from the ' +
              'sticker below.',
          );
          return;
        }
        const row = result.lot;
        // Was this lot's line item refunded (mig 0245)? That's what turns a
        // 'won' lot back into store inventory.
        let refunded = false;
        let ownerInfo: OwnerInfo | null = null;
        if (row.status === 'won') {
          const { data: il } = await supabase
            .from('invoice_lots')
            .select('refunded_at')
            .eq('lot_id', row.id)
            .not('refunded_at', 'is', null)
            .limit(1);
          refunded = (il?.length ?? 0) > 0;
          // Who won it? A blocked relot ("belongs to a customer") is useless
          // without the customer — resolve owner + invoice via the shared RPC.
          const { data: ownerRes } = await supabase.rpc('staff_scan_lot_owner', {
            p_candidates: [row.lot_code, row.sticker_code, source].filter(Boolean) as string[],
          });
          const parsed = ownerRes as { ok?: boolean; owner?: OwnerInfo | null } | null;
          if (parsed?.ok && parsed.owner) ownerInfo = parsed.owner;
        }
        setFound({ ...row, refunded, hoppedFrom: result.hoppedFrom });
        setOwner(ownerInfo);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        const m = (err as Error).message;
        Alert.alert(
          "Couldn't look that up",
          m.startsWith('lookup_failed: ')
            ? `The lookup itself failed, so this is NOT a problem with the sticker. Check the tablet's connection and try again.\n\n${m.slice('lookup_failed: '.length)}`
            : m,
        );
      } finally {
        setSearching(false);
      }
    },
    [query, role],
  );

  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (!codeFromUrl || autoSearchedRef.current || role.kind !== 'staff') return;
    autoSearchedRef.current = true;
    void search(codeFromUrl);
  }, [codeFromUrl, role, search]);

  const onRefundedRelisted = useCallback(
    (result: RelistAfterRefundResult) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Relotted to inventory',
        `${found?.lot_code ?? 'This item'} is back in inventory as ${result.lot_code ?? 'a new lot'}.\n\nIt is NOT in an auction — someone has to assign it to one deliberately.\n\nNext: put it away, then update the photos, title, and condition on the new listing.`,
        [{ text: 'Edit new listing', onPress: () => router.replace(`/worklist/${String(result.lot_id)}`) }],
      );
    },
    [found, router],
  );

  // The BRN/PNK/TEA pre-sticker rolls print 1D barcodes, not QR, and lot QRs
  // are QR — accept the same full retail set the other staff scanners do.
  const lotScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      if (searching || scanLockRef.current || found) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      const prev = lastScanRef.current;
      const nowMs = Date.now();
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastScanRef.current = { value: c.data, at: nowMs };
      scanLockRef.current = true;
      void Haptics.selectionAsync();
      // Show staff what was read, then resolve that exact value — passing it
      // explicitly because `query` state won't have updated yet.
      setQuery(c.data);
      // Do NOT close the camera here. Staff work a cart of returns one after
      // another; unmounting on every read meant re-tapping "Scan sticker" for
      // each item, and again after every "Not found" — which is most of what
      // "relots are piling up" feels like from the floor. `isActive` below
      // already stops the session once a lot is found, and `openScanner`
      // re-arms it, so the session pauses instead of tearing down.
      void search(c.data).finally(() => {
        scanLockRef.current = false;
      });
    },
  });

  const openScanner = useCallback(async () => {
    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) {
        Alert.alert(
          'Camera needed',
          'Allow camera access to scan a sticker, or type the code instead.',
        );
        return;
      }
    }
    setFound(null);
    setOwner(null);
    scanLockRef.current = false;
    lastScanRef.current = null;
    setScanning(true);
  }, [hasPermission, requestPermission]);

  /** Clear the matched card and re-arm the (still-mounted) scanner. Also clears
   *  the dedup memory so re-reading the SAME label is allowed — staff do that
   *  deliberately when they want to re-check an item they just looked at. */
  const scanNext = useCallback(() => {
    setFound(null);
    setOwner(null);
    setQuery('');
    scanLockRef.current = false;
    lastScanRef.current = null;
    setScanning(true);
  }, []);

  const relot = useCallback(async () => {
    if (!found || role.kind !== 'staff') return;
    if (!found.warehouse_id) {
      Alert.alert('Cannot relot', 'This lot has no warehouse on file — fix that on the operator console first.');
      return;
    }
    setRelotting(true);
    try {
      // 0353: relot puts the item back in INVENTORY. It does not choose an
      // auction, and nothing here may choose one on the owner's behalf:
      // "I do not want anything automatically scheduled into an auction—ever.
      // Every item must remain unscheduled until an employee deliberately
      // chooses an auction and confirms the assignment."
      //
      // This screen used to grab the soonest-closing auction and commit in the
      // same tap, which is how a disposed chair ended up listed in "Sweater
      // Weather Steals". Passing NULL mints the child 'in_inventory' with no
      // auction, no lot_number and no close_at. Assignment is a separate,
      // deliberate step through the Auction Builder (assign_lots_to_auction,
      // which only accepts in_inventory lots — the states already line up).
      //
      // The client-side "flip won -> unsold" that used to run here is gone
      // too: 0353 lets the RPC accept a 'won' lot whose every invoice line is
      // refunded. That flip needed the lots table UPDATE grant, which mig 0133
      // gives to admin/manager only, so a picker could never relot a refunded
      // return. Now they can — the server decides, not the client's role.
      const { data: newLotId, error: rpcErr } = await supabase.rpc('relist_lot_into_auction', {
        p_lot_id: found.id,
        p_auction_id: null,
        p_lotted_by_worker: getActiveLottingWorkerId(),
      });
      if (rpcErr) throw new Error(rpcErr.message);
      // The RPC returns NULL (not an error) when the source row has vanished
      // between the scan and the commit. Without this the success alert fired
      // and "Edit new listing" navigated to /worklist/null.
      if (!newLotId) {
        throw new Error('relist_returned_no_lot');
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Relotted to inventory',
        `${found.lot_code} now has a new lot code and is back in inventory.\n\nIt is NOT in an auction — someone has to assign it to one deliberately.\n\nNext: update the photos, title, and condition on the new listing.`,
        [
          {
            text: 'Edit new listing',
            onPress: () => router.replace(`/worklist/${String(newLotId)}`),
          },
        ],
      );
    } catch (err) {
      const msg = (err as Error).message;
      // 0275 guard: the source already has an active relist child. Point staff
      // at the new lot code carried in the raw message instead of the dead one.
      const existingCode = msg.match(/lives on lot\s+(\S+)/)?.[1] ?? null;
      // Every guard the RPC can raise gets a sentence a warehouse can act on.
      // Five of these used to surface as the raw Postgres string.
      const explain = (): string => {
        if (msg.startsWith('lookup_failed: ')) {
          return `Couldn't reach BinGo to look that code up, so this is NOT a problem with the sticker. Check the tablet's connection and try again.\n\n${msg.slice('lookup_failed: '.length)}`;
        }
        if (msg.includes('relist_source_already_relisted')) {
          return `This item was already relotted${existingCode ? ` — it now lives on lot ${existingCode}` : ''}. Look up that new lot code; this original is retired.`;
        }
        if (msg.includes('relist_source_wrong_status')) {
          // 0353 widened this to include a 'won' lot whose every invoice line
          // is refunded. Reaching here on a 'won' lot now means the item is
          // still owed to a customer on at least one line.
          return found.status === 'won'
            ? 'This item still belongs to a customer — at least one line on their invoice has not been refunded. Refund it first, then relot.'
            : `This lot's status doesn't allow relotting (${found.status}). Only unsold, in-inventory, or fully refunded items can be relotted.`;
        }
        if (msg.includes('relist_lot_code_mint_failed')) {
          return 'Could not mint a new lot code for this operator. That needs an admin on the console — nothing is wrong with the item.';
        }
        if (msg.includes('relist_returned_no_lot')) {
          return 'This lot disappeared while relotting — someone may have deleted or changed it. Scan it again to see its current state.';
        }
        if (msg.includes('duplicate key') && msg.includes('sticker_code')) {
          return 'Another lot already holds this box\'s label, so the new listing could not take it. Flag this item for an admin — its relist history needs untangling.';
        }
        return msg;
      };
      Alert.alert('Could not relot', explain());
    } finally {
      setRelotting(false);
    }
  }, [found, role, router]);

  // Which explanation + button state does the found lot get?
  const relottable =
    found !== null &&
    (['unsold', 'in_inventory', 'relisted'].includes(found.status) ||
      (found.status === 'won' && found.refunded));

  // The screen used to render in full while `role` was still resolving, and
  // `search`/`relot` both began with a silent `if (role.kind !== 'staff') return`.
  // So during that window — and FOREVER if the role lookup errored, because
  // useOperatorRole deliberately fails open by returning without setting state
  // — scanning closed the camera and did nothing, "Find item" did nothing, and
  // "Relot" did nothing, with no message anywhere. That is the shape of the
  // 2026-08-10 "relotting and the camera aren't working" report. Say what is
  // happening instead of rendering a dead screen (matches find.tsx:264).
  if (role.kind !== 'staff') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={s.header}>
          <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '900', flex: 1 }}>
            Relot an item
          </Text>
          <Pressable onPress={() => router.back()} style={s.cancelBtn} hitSlop={12}>
            <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>Cancel</Text>
          </Pressable>
        </View>
        <View style={{ padding: 24, gap: 12, alignItems: 'center' }}>
          {role.kind === 'loading' ? (
            <>
              <ActivityIndicator color={colors.primary} />
              <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center' }}>
                Checking your account…
              </Text>
            </>
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              This device isn&apos;t signed in to a staff account, so relotting is unavailable.
              Sign out and back in, or ask an admin to check your access.
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={s.header}>
        <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '900', flex: 1 }}>
          Relot an item
        </Text>
        <Pressable onPress={() => router.back()} style={s.cancelBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19 }}>
          For items that came back — unsold, no-show, or refunded returns. Enter the code off the
          item&apos;s sticker; the original lot is retired and a NEW listing (new lot code) is
          created, keeping the item&apos;s history linked. The item goes back into inventory and
          is NOT put in an auction — someone assigns it to one deliberately, later. You&apos;ll
          update photos and details on the next screen.
        </Text>

        {scanning && device ? (
          <View style={s.cameraBox}>
            <Camera
              ref={cameraRef}
              style={{ flex: 1 }}
              device={device}
              isActive={cameraGate && scanning && !searching && !found}
              codeScanner={lotScanner}
            />
            <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
            {focus.indicator}
            {searching && (
              <View style={s.cameraBusy}>
                <ActivityIndicator color={colors.primary} />
              </View>
            )}
          </View>
        ) : scanning ? (
          // useBackCamera() hasn't resolved a device yet (or this hardware has
          // none). Previously this branch rendered NOTHING, so tapping "Scan
          // sticker" appeared to do nothing at all — indistinguishable from a
          // broken camera. Say so, and leave the code entry below reachable.
          <View style={[s.cameraBox, { alignItems: 'center', justifyContent: 'center', gap: 10 }]}>
            <ActivityIndicator color={colors.primary} />
            <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingHorizontal: 20 }}>
              Starting the camera… if it doesn&apos;t appear, type the code below instead.
            </Text>
          </View>
        ) : null}

        {/* With the camera now staying mounted between reads, a matched item
            pauses the session (`isActive` drops on `found`) rather than tearing
            it down — so the next item needs one tap to clear the card and
            re-arm, not a full scanner restart. */}
        {found ? (
          <Pressable onPress={scanNext} style={s.primaryBtn}>
            <Text style={s.primaryBtnText}>Scan next item</Text>
          </Pressable>
        ) : scanning ? (
          <Pressable onPress={() => setScanning(false)} style={s.secondaryBtn}>
            <Text style={s.secondaryBtnText}>Turn the camera off</Text>
          </Pressable>
        ) : (
          <Pressable onPress={openScanner} style={s.primaryBtn}>
            <Text style={s.primaryBtnText}>Scan sticker</Text>
          </Pressable>
        )}

        {/* Code entry stays visible WHILE scanning. It used to be hidden behind
            `!scanning`, so a label the camera could not read (dim aisle, scuffed
            sticker) meant backing out of the scanner to type it — the same
            dead-end Lot Lookup avoids by showing both at once
            (layout/lots/find.tsx:349-370). */}
          <View>
            <Text style={s.fieldLabel}>Lot code / sticker code / QR link</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="e.g. BG-1042 or A17 or https://…/l/…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[s.textInput, { fontFamily: 'monospace' }]}
              returnKeyType="search"
              onSubmitEditing={() => void search()}
            />
          </View>

          <Pressable
            onPress={() => void search()}
            disabled={searching || !query.trim()}
            style={[s.secondaryBtn, (searching || !query.trim()) && { opacity: 0.5 }]}
          >
            {searching ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={s.secondaryBtnText}>Find item</Text>
            )}
          </Pressable>

        {found?.hoppedFrom && (
          <Text style={s.hopNotice}>
            That label is on retired lot {found.hoppedFrom} — it was already relotted. Showing the
            item&apos;s current listing below.
          </Text>
        )}

        {found && (
          <View style={s.foundCard}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {found.photo_urls?.[0] ? (
                <Image
                  source={{ uri: found.photo_urls[0] }}
                  style={{ width: 72, height: 72, borderRadius: 8, resizeMode: 'cover' }}
                />
              ) : (
                <View style={[{ width: 72, height: 72, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, { backgroundColor: colors.surface }]}>
                  <Text style={{ fontSize: 24 }}>📦</Text>
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }} numberOfLines={2}>
                  {found.title}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
                  {found.lot_code}
                  {found.sticker_code ? ` · sticker ${found.sticker_code}` : ''}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  status: {found.status}
                  {found.refunded ? ' · refunded back to store' : ''}
                  {isRefundedLot(found.status) ? ` · ${REFUNDED_TAG}` : ''}
                  {(found.relist_count ?? 0) > 0 ? ` · relist #${found.relist_count}` : ''}
                </Text>
              </View>
            </View>

            {owner && (
              <View
                style={{
                  gap: 3,
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                }}
              >
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: 11,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                  }}
                >
                  Winning customer
                </Text>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                  {owner.bidder_name ?? '—'}
                  {owner.bidder_number != null ? ` · Bidder #${owner.bidder_number}` : ''}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  Invoice {(owner.invoice_status ?? '—').replace(/_/g, ' ')}
                  {owner.invoice_id ? ` · #${owner.invoice_id.slice(-8)}` : ''}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  {ownerPickupStatus(owner)}
                </Text>
              </View>
            )}

            {isRefundedLot(found.status) ? (
              <RefundedRelistForm
                key={found.id}
                lotId={found.id}
                operatorId={role.operatorId}
                onDone={onRefundedRelisted}
              />
            ) : relottable ? (
              <Pressable
                onPress={relot}
                disabled={relotting}
                style={[s.primaryBtn, relotting && { opacity: 0.5 }]}
              >
                {relotting ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={s.primaryBtnText}>
                    Relot — new listing, new code
                  </Text>
                )}
              </Pressable>
            ) : (
              <Text style={{ color: '#f59e0b', fontSize: 13, lineHeight: 19 }}>
                {found.status === 'won'
                  ? 'This item was won and NOT refunded — it belongs to a customer. Refund it first (operator console) if it was returned.'
                  : found.status === 'live' || found.status === 'scheduled'
                    ? 'This lot is in an open auction — it can only be relotted after it closes.'
                    : `Status "${found.status}" can't be relotted from here.`}
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  textInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
  },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  cameraBox: {
    height: 260,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cameraBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hopNotice: {
    color: colors.winning,
    fontSize: 13,
    lineHeight: 19,
  },
  foundCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 12,
  },
});
