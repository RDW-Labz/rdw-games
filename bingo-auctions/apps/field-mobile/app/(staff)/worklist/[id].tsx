// Inventory detail / edit — mirrors operator-web's /lots/[id]/edit but
// scoped to the fields that matter on the warehouse floor:
//   - title, description, category, condition
//   - msrp, starting_bid (dollar inputs; converted to cents)
//   - photo_urls (display + clear; recapture is a future addition)
//
// Out of MVP — defer to operator-web for now:
//   - Dutch-auction fields (start, floor, decline-per-minute)
//   - flat_price (Make Offer)
//   - Bin reassignment (handled by picker workflow)
//   - Status flips (intake-scan / put-away handle these)
//   - Delete (intentionally omitted from mobile to prevent thumb-fumble loss)
//
// Stale-row guard: we fetch the row once on mount. If the save fails
// because the row was edited from another device (RLS UPDATE returning
// 0 rows is the signal), we surface a clear refresh prompt.

import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { supabase, useOperatorRole, hasOperatorRole } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';
import { parseCents, getActiveLottingWorkerId } from '@auction-platform/domain-lotting';
import {
  EditableCandidateCard,
  candidateToEditable,
  type EditableCandidate,
} from '@/features/lotting/EditableCandidateCard';
import { useLotUpdate } from '@/features/lotting/useLotUpdate';
import { uploadPendingPhotos, isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { persistPhoto } from '@/lib/persist-photo';
import {
  enqueueLotPhoto,
  photoQueueCountSafe,
  drainPhotoQueue,
  subscribePhotoQueue,
} from '@/lib/photo-upload-queue';
import { mergePhotoUrls, mergePhotosAfterSave } from '@/lib/photo-merge';
import { applyLotPhotoDelta } from '@/lib/lot-photo-delta';
import { useLottingSession } from '@/features/lotting/SessionContext';
import { LotQRCard } from '@/features/lotting/LotQRCard';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import { Camera, useCameraPermission } from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { TAKE_PHOTO_OPTIONS, safeFlash, translateCaptureError } from '@/lib/vision-camera';
import { duplicateLotArgs } from '@/lib/duplicate-lot-args';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { CameraFlashButton, type FlashMode } from '@/features/lotting/CameraFlashButton';
// As of C1 the LottingSessionProvider is mounted at (staff)/_layout, so
// every staff screen (including this one) has access. Earlier the
// provider was scoped to /lotting only and this screen had to inline
// safe defaults to avoid crashing — that workaround is no longer needed.

// ── Type for the row we fetch ────────────────────────────────────────────────

type LotRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  description: string | null;
  category: string | null;
  condition: 'appears_new' | 'open_box' | 'good' | 'as_is';
  msrp_cents: number | null;
  starting_bid_cents: number;
  photo_urls: string[];
  external_code: string | null;
  // 2026-05-20: unsold added so this screen can edit + relist lots that
  // closed without a buyer. (Auto-relist via the cron handles the bulk
  // case; this is the manual "I want it in NOW" path for staff.)
  // 'draft' is loadable and editable here — the fetch below never filtered on
  // status, only the screens LINKING here did (fixed 2026-08-20). An
  // interrupted listing lands in draft and is exactly what someone needs to
  // come back and finish.
  status: 'draft' | 'pending_intake' | 'in_inventory' | 'unsold';
  warehouse_id: string | null;
  relist_count: number | null;
  // Where this lot currently sits, so a duplicate can offer "same bin" in one
  // tap. qr_token is what intake_lot_to_bin takes — the same token the bin
  // sticker encodes, so the one-tap path and the scan path hit one RPC.
  intake_bin_id: string | null;
  // PostgREST types an embedded to-one join as an array; normalized by
  // sourceBin() below rather than casting it away at the fetch.
  intake_bin: Array<{ code: string; qr_token: string }> | { code: string; qr_token: string } | null;
};

// ── Main screen ───────────────────────────────────────────────────────────────

// duplicate_lot (mig 0299) failure reasons -> operator-readable copy.
// clear_sticker_code (0300) / discard_lot failure reasons.
const STICKER_FIX_REASON_COPY: Record<string, string> = {
  not_operator_staff: "You're no longer signed in as staff — restart the app.",
  lot_not_found: "Couldn't find that lot — pull to refresh and retry.",
  lot_other_operator: 'That lot belongs to a different operator — sign out and back in.',
  lot_not_editable:
    'This lot has already reached an auction or a buyer — fix it from the operator console instead.',
};

// remove_lot_from_inventory (0319) failure reasons -> operator-readable copy.
const REMOVAL_REASON_COPY: Record<string, string> = {
  not_operator_staff: "You're no longer signed in as staff — restart the app.",
  admin_or_manager_required:
    'A manager has to mark an item destroyed. Ask one to sign in on this tablet.',
  lot_not_found: "Couldn't find that lot — pull to refresh and retry.",
  lot_other_operator: 'That lot belongs to a different operator — sign out and back in.',
  invalid_removal_kind: 'That removal reason is not one the server accepts — report this.',
  // The guard that matters most on the floor: an item with live bids cannot
  // just vanish, because a bidder is already owed an outcome.
  lot_has_bids:
    'This lot already has bids. Cancel it in the operator console first, then mark it destroyed.',
  removal_kind_conflict:
    'This lot was already removed for a different reason — check it in the operator console.',
};

const DUPLICATE_REASON_COPY: Record<string, string> = {
  not_operator_staff: "You're no longer signed in as staff — restart the app.",
  lot_not_found: "Couldn't find that lot — pull to refresh and retry.",
  lot_other_operator: 'That lot belongs to a different operator — sign out and back in.',
  lot_code_mint_failed: 'Could not mint a new lot code — contact your admin.',
};

export default function InventoryDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useOperatorRole();
  const { session } = useLottingSession();
  const { update, updating } = useLotUpdate();

  const [lot, setLot] = useState<LotRow | null>(null);
  const [editable, setEditable] = useState<EditableCandidate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Membership perk 3 (staging & prep): true when this lot's winning bidder
  // holds an active/trialing membership at this operator whose plan has
  // staging_prep. Proactive staff signal — shown so staff stage & prep the
  // member's lots ahead of arrival. Read-only: does NOT touch bin_assignments
  // or pickup_mode. (mig 0177 schema.)
  const [stagePrep, setStagePrep] = useState(false);

  // Track if any field has changed so we can disable Save when there's
  // nothing to save. Compared against the initial editable state.
  const [initial, setInitial] = useState<EditableCandidate | null>(null);
  const isDirty =
    editable && initial ? JSON.stringify(editable) !== JSON.stringify(initial) : false;

  // ── Post-creation photo capture ──────────────────────────────────────────
  // The lot detail screen previously only allowed CLEARING photos (× on
  // each thumbnail). Operators frequently want to add MORE photos after
  // creating a lot — e.g. they shot a hero in Quick Lot but want
  // condition shots later, or the AI scan returned only stock photos
  // and they want real ones too. This adds an inline camera modal and
  // an "+ Add photo" button below the existing photo strip.
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  // null = the storage read has not succeeded yet (cold launch + unreadable
  // store), so the badge must not claim "nothing waiting".
  const [photosWaiting, setPhotosWaiting] = useState<number | null>(null);
  const [addPhotoFlash, setAddPhotoFlash] = useState<FlashMode>('auto');
  const addPhotoCameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(addPhotoCameraRef);
  // Capture callbacks finish after the render that started them. Reading
  // `lot`/`editable` from that render erased photos captured in between, and a
  // later Save could persist the older list and detach them. Keep the latest
  // values in refs and merge every update instead of replacing.
  const lotRef = useRef<LotRow | null>(null);
  const editableRef = useRef<EditableCandidate | null>(null);
  useEffect(() => {
    lotRef.current = lot;
  }, [lot]);
  useEffect(() => {
    editableRef.current = editable;
  }, [editable]);

  useEffect(
    () =>
      subscribePhotoQueue(() => {
        const current = lotRef.current;
        if (!current) return;
        void photoQueueCountSafe(current.id).then(setPhotosWaiting);
      }),
    [],
  );

  const captureAndAttach = async () => {
    const currentLot = lotRef.current;
    if (!currentLot || !editableRef.current || role.kind !== 'staff') return;
    if (!addPhotoCameraRef.current) {
      Alert.alert('Camera not ready', 'Wait a moment and tap the shutter again.');
      return;
    }
    setUploadingPhoto(true);
    try {
      const photo = await addPhotoCameraRef.current.takePhoto({
        flash: safeFlash(device, addPhotoFlash),
        ...TAKE_PHOTO_OPTIONS,
      });
      const uri = await persistPhoto(`file://${photo.path}`);
      const queued = await enqueueLotPhoto({
        lotId: currentLot.id,
        lotCode: currentLot.lot_code,
        operatorId: role.operatorId,
        localUri: uri,
      });
      if (queued.id == null) {
        Alert.alert(
          "Couldn't queue photo",
          queued.status === 'missing'
            ? 'That photo file is no longer on this phone. Take it again.'
            : 'The photo is saved on this phone but was not queued. Try again before leaving this screen.',
        );
        return;
      }
      setPhotosWaiting(await photoQueueCountSafe(currentLot.id));
      setUploadingPhoto(false);
      setCameraOpen(false);

      // Drain in the background. The queue keeps the photo in Documents and
      // retries after an app kill/restart; a failed PATCH only retries the
      // PATCH, not the upload.
      void drainPhotoQueue()
        .then(async (drained) => {
          const added = drained.uploadedUrls
            .filter((item) => item.lotId === currentLot.id)
            .map((item) => item.url);
          if (added.length > 0) {
            setLot((prev) =>
              prev && prev.id === currentLot.id
                ? { ...prev, photo_urls: mergePhotoUrls(prev.photo_urls, added) }
                : prev,
            );
            setEditable((prev) =>
              prev ? { ...prev, stockPhotos: mergePhotoUrls(prev.stockPhotos, added) } : prev,
            );
            setInitial((prev) =>
              prev ? { ...prev, stockPhotos: mergePhotoUrls(prev.stockPhotos, added) } : prev,
            );
          }
          setPhotosWaiting(await photoQueueCountSafe(currentLot.id));
        })
        .catch(() => {
          Alert.alert('Photo upload failed', 'The photo stays queued. Retry when you are online.');
        });
    } catch (err) {
      Alert.alert('Photo capture failed', translateCaptureError(err));
    } finally {
      setUploadingPhoto(false);
      setCameraOpen(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    if (role.kind !== 'staff') return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: e } = await supabase
        .from('lots')
        .select(
          'id, lot_code, sticker_code, display_code, title, description, category, condition, msrp_cents, starting_bid_cents, photo_urls, external_code, status, warehouse_id, relist_count, intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code, qr_token)',
        )
        .eq('id', id)
        .eq('operator_id', role.operatorId)
        .is('deleted_at', null) // 0057: don't open soft-deleted (trash) lots
        .maybeSingle();
      if (cancelled) return;
      if (e) {
        setError(e.message);
        setLoading(false);
        return;
      }
      if (!data) {
        setError('Lot not found, or it belongs to another operator.');
        setLoading(false);
        return;
      }
      const row = data as LotRow;
      setLot(row);
      void photoQueueCountSafe(row.id).then(setPhotosWaiting);

      // Membership perk 3: resolve the white-glove (stage & prep) badge for
      // this lot's winning bidder. A lot is "won" via invoice_lots → invoices;
      // we read the winning bidder, then check their active membership plan at
      // this operator for staging_prep. Best-effort: any miss (unsold lot, no
      // membership, RLS, types predating mig 0177) leaves the badge off.
      // bidder_subscriptions has an operator-staff read policy (mig 0013) and
      // operator_pro_plans is staff-readable for its operator (mig 0177), so
      // this resolves under the staff session. The embeds are read via explicit
      // casts because operator_pro_plans/plan_id land in mig 0177 (after this
      // worktree's generated types).
      void (async () => {
        const { data: ilData } = await supabase
          .from('invoice_lots')
          .select('invoices(bidder_id, operator_id)')
          .eq('lot_id', row.id)
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        const winner =
          (
            ilData as unknown as {
              invoices: { bidder_id: string; operator_id: string | null } | null;
            } | null
          )?.invoices ?? null;
        const bidderId = winner?.bidder_id ?? null;
        // Trust the lot's own operator scope (role.operatorId) — invoices for
        // this lot are at the same operator.
        if (!bidderId) {
          setStagePrep(false);
          return;
        }
        const { data: subData } = await supabase
          .from('bidder_subscriptions')
          .select('status, current_period_end, operator_pro_plans(staging_prep)')
          .eq('bidder_id', bidderId)
          .eq('operator_id', role.operatorId)
          .in('status', ['active', 'trialing'])
          .maybeSingle();
        if (cancelled) return;
        const sub = subData as unknown as {
          status: string;
          current_period_end: string | null;
          operator_pro_plans: { staging_prep: boolean | null } | null;
        } | null;
        const active =
          !!sub &&
          (sub.current_period_end == null ||
            new Date(sub.current_period_end).getTime() > Date.now());
        setStagePrep(active && sub?.operator_pro_plans?.staging_prep === true);
      })();

      // Map LotRow → EditableCandidate via the existing helper. We bridge
      // cents → dollar strings for UX (TextInput needs strings); save flow
      // converts back. The session defaults are passed through but should
      // not be needed since the row already has values for everything.
      const candidate = {
        title: row.title,
        brand: '',
        model: '',
        upc: row.external_code ?? '',
        category: row.category ?? '',
        condition: row.condition,
        msrp: row.msrp_cents != null ? row.msrp_cents / 100 : null,
        startBid: row.starting_bid_cents / 100,
        description: row.description ?? '',
        stockPhotos: row.photo_urls,
      };
      const ed = candidateToEditable(candidate, {
        defaultCondition: session.defaultCondition,
        defaultStartBid: session.defaultStartBid,
      });
      // W2 (2026-05-26): the prior useAiPricer:true hack meant "keep
      // whatever startBid the row already has, don't clobber to session
      // default." Now that useAiPricer is gone (plan D4),
      // candidateToEditable always uses defaultStartBid. The edit screen
      // needs to preserve the persisted value, so override after.
      ed.startBidDollars = (row.starting_bid_cents / 100).toFixed(2);
      setEditable(ed);
      setInitial(ed);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, role, session.defaultCondition, session.defaultStartBid]);

  // ── Duplicate Lot (request 2026-07-29) ──────────────────────────────────────
  // "We often receive multiple identical items... copy the current lot exactly.
  // The only thing that should not be duplicated is the sticker/lot code. After
  // tapping Duplicate Lot: create a new identical lot, prompt the user to scan
  // or bind a new sticker code, save the new lot with the new sticker."
  //
  // The clone itself is server-side (duplicate_lot, mig 0299) so the
  // copy/omit rules live in one place — in particular it leaves
  // relisted_from_lot_id NULL. A duplicate is a DIFFERENT box, not the same box
  // relisted; lineage here would make a case of six identical items look like
  // six listings of one item to the 0275/0294 duplicate guards.
  //
  // On success we open the SAME PreStickeredScanner the lotting screens use, so
  // binding the new sticker behaves identically to Flow B (including its
  // manager-only skip gate and success confirmation).
  const [duplicating, setDuplicating] = useState(false);
  const [dupSticker, setDupSticker] = useState<{
    lotId: string;
    lotCode: string;
    rebind?: boolean;
  } | null>(null);

  async function handleDuplicate() {
    if (!lot || duplicating) return;
    setDuplicating(true);
    try {
      // 0416: credit the copy to the clocked-in PIN worker, the same way the
      // create-draft and relist paths do. Without it the copy was credited to
      // nobody (Oct 13: 40 of 108 Crandall lots). The server validates the id
      // and falls back to the source lot's worker when it is null or invalid.
      const { data, error } = await supabase.rpc(
        'duplicate_lot',
        duplicateLotArgs(lot.id, getActiveLottingWorkerId()),
      );
      if (error) throw new Error(error.message);
      // 0326: the duplicate is always minted 'pending_intake' with no shelf,
      // so it enters the put-away queue and gets scanned onto wherever it
      // actually goes. 0322 used to copy the source's bin when the source was
      // shelved; that made the copy claim a shelf it had never been on, and
      // putting it away elsewhere read as a move (reported 2026-08-18). What
      // 0322 got right and this keeps: it is not 'draft' any more — nothing
      // lists draft, which is why duplicates used to be reachable only by
      // searching for them one at a time.
      const res = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        lot_id?: string;
        lot_code?: string;
        status?: string;
        on_shelf?: boolean;
      };
      if (!res.ok || !res.lot_id || !res.lot_code) {
        Alert.alert(
          'Could not duplicate',
          DUPLICATE_REASON_COPY[res.reason ?? ''] ?? res.reason ?? 'Unknown error.',
        );
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Straight into the sticker prompt for the NEW lot.
      setDupSticker({ lotId: res.lot_id, lotCode: res.lot_code });
    } catch (err) {
      Alert.alert('Could not duplicate', (err as Error).message);
    } finally {
      setDuplicating(false);
    }
  }

  // Where did the copy actually go? Offered right after the duplicate's sticker
  // is bound, while the lotter is still holding it. "Same bin" resolves in one
  // tap through the SAME RPC the scanner uses (intake_lot_to_bin takes the
  // bin's qr_token, which is what the bin sticker encodes) — so the one-tap
  // path and the scan path cannot drift apart. Offered only when the SOURCE lot
  // is actually on a shelf; there is nothing to inherit otherwise.
  async function putDuplicateOnSourceBin(dupLotCode: string, binCode: string, binToken: string) {
    const { data, error } = await supabase.rpc('intake_lot_to_bin', {
      p_lot_identifier: dupLotCode,
      p_bin_qr_token: binToken,
    });
    const res = (data ?? {}) as { ok?: boolean; reason?: string };
    if (error || !res.ok) {
      Alert.alert(
        'Could not shelve it',
        `${dupLotCode} is saved, but putting it on ${binCode} failed${
          error?.message || res.reason ? `: ${error?.message ?? res.reason}` : '.'
        } Scan it into a bin from Put away.`,
      );
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Done', `${dupLotCode} is on ${binCode} and ready to build auctions with.`);
  }

  function sourceBin(): { code: string; qr_token: string } | null {
    const raw = lot?.intake_bin ?? null;
    const one = Array.isArray(raw) ? raw[0] : raw;
    return one?.qr_token ? one : null;
  }

  function askWhereTheDuplicateWent(dupLotCode: string) {
    const bin = sourceBin();
    const buttons: Array<{ text: string; style?: 'cancel'; onPress?: () => void }> = [];
    if (bin?.qr_token) {
      buttons.push({
        text: `Same bin (${bin.code})`,
        onPress: () => void putDuplicateOnSourceBin(dupLotCode, bin.code, bin.qr_token),
      });
    }
    buttons.push({ text: 'Scan a bin', onPress: () => router.push('/put-away/single') });
    buttons.push({ text: 'Later', style: 'cancel' });
    Alert.alert(
      'Where did it go?',
      `${dupLotCode} has its sticker. It can't be added to an auction until it's on a shelf — ${
        bin?.qr_token ? `tap the bin it went on, or scan a different one.` : `scan it into a bin.`
      }`,
      buttons,
    );
  }

  // ── Sticker correction + discard (request 2026-07-29) ───────────────────────
  // "If someone accidentally scans an LPN, a SKU, or the wrong pre-sticker
  // code, there is currently no way to remove or replace the bound sticker
  // code... add the ability to remove an incorrect code, replace it, and delete
  // an accidentally created lot before it enters an auction."
  //
  // Replace (rebind_sticker_code, 0249) and discard (discard_lot) already
  // existed — but only in the post-save panel on the quick-lotting screen, so
  // they vanished the moment the lotter navigated away, which is exactly when
  // the mistake tends to be noticed. Remove is new (clear_sticker_code, 0300).
  //
  // All three share the same floor-recovery scope the RPCs enforce; the UI is
  // hidden outside it rather than letting staff tap into a guaranteed refusal.
  const STICKER_FIXABLE = ['pending_intake', 'in_inventory', 'draft'];
  const canFixSticker = !!lot && STICKER_FIXABLE.includes(lot.status);
  const [stickerBusy, setStickerBusy] = useState(false);

  function confirmClearSticker() {
    if (!lot) return;
    Alert.alert(
      'Remove sticker code?',
      `${lotDisplayCode(lot) ?? lot.lot_code} will have no sticker until you bind a new one. ` +
        'The pre-printed sticker goes back in the pool so the right lot can claim it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setStickerBusy(true);
              try {
                const { data, error } = await supabase.rpc('clear_sticker_code', {
                  p_lot_id: lot.id,
                });
                if (error) throw new Error(error.message);
                const res = (data ?? {}) as { ok?: boolean; reason?: string };
                if (!res.ok) {
                  Alert.alert(
                    'Could not remove',
                    STICKER_FIX_REASON_COPY[res.reason ?? ''] ?? res.reason ?? 'Unknown error.',
                  );
                  return;
                }
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert('Sticker removed', 'Scan the correct sticker when you have it.');
                setLot({ ...lot, sticker_code: null });
              } catch (err) {
                Alert.alert('Could not remove', (err as Error).message);
              } finally {
                setStickerBusy(false);
              }
            })();
          },
        },
      ],
    );
  }

  function confirmDiscardLot() {
    if (!lot) return;
    Alert.alert(
      'Discard this lot?',
      `${lotDisplayCode(lot) ?? lot.lot_code} will be removed from inventory. ` +
        'Use this only for a lot created by mistake — it cannot be undone from the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setStickerBusy(true);
              try {
                const { data, error } = await supabase.rpc('discard_lot', {
                  p_lot_id: lot.id,
                  p_reason: 'created by mistake during lotting',
                });
                if (error) throw new Error(error.message);
                const res = (data ?? {}) as { ok?: boolean; reason?: string };
                if (!res.ok) {
                  Alert.alert(
                    'Could not discard',
                    STICKER_FIX_REASON_COPY[res.reason ?? ''] ?? res.reason ?? 'Unknown error.',
                  );
                  return;
                }
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                router.back();
              } catch (err) {
                Alert.alert('Could not discard', (err as Error).message);
              } finally {
                setStickerBusy(false);
              }
            })();
          },
        },
      ],
    );
  }

  // ── Destroy (staff member, 2026-08-20) ─────────────────────────────────────────────
  // "We need a 'destroy' button for items that are broken to pieces such as
  // mirrors or sinks."
  //
  // The database has had this since 0319 — remove_lot_from_inventory with
  // kind='destroyed' sets status=disposed, pins it there with a trigger, and
  // refuses a scheduled/live lot that already carries bids. Only the operator
  // console ever called it, so a picker holding a shattered mirror had to
  // either leave it in inventory or ask someone at a desk.
  //
  // NOT the same button as Discard, and worth keeping apart:
  //   Discard  → this LOT is a mistake (mis-scan, junk row). The item is fine.
  //   Destroy  → the ITEM is gone. The lot was right; the thing it describes
  //              no longer exists.
  // Collapsing them would make shrinkage indistinguishable from typos in
  // every report that reads removal_kind.
  //
  // The reason is asked as three taps rather than typed: this is a person
  // holding a broken sink, and a keyboard is the wrong ask. Anything more
  // specific belongs in the note field on the console.
  function confirmDestroy() {
    if (!lot || stickerBusy) return;
    const code = lotDisplayCode(lot) ?? lot.lot_code;

    const destroy = (note: string) => {
      void (async () => {
        setStickerBusy(true);
        try {
          const { data, error } = await supabase.rpc('remove_lot_from_inventory', {
            p_lot_id: lot.id,
            p_kind: 'destroyed',
            p_note: note,
          });
          if (error) throw new Error(error.message);
          const res = (data ?? {}) as { ok?: boolean; reason?: string };
          if (!res.ok) {
            Alert.alert(
              'Could not mark it destroyed',
              REMOVAL_REASON_COPY[res.reason ?? ''] ?? res.reason ?? 'Unknown error.',
            );
            return;
          }
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
        } catch (err) {
          Alert.alert('Could not mark it destroyed', (err as Error).message);
        } finally {
          setStickerBusy(false);
        }
      })();
    };

    Alert.alert(
      'Item destroyed?',
      `${code} will be removed from inventory as DESTROYED and can't be sold. ` +
        'This is for an item that is physically broken or gone — if the lot ' +
        'itself was a mistake, use Discard instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Broken',
          style: 'destructive',
          onPress: () => destroy('broken — reported from the floor'),
        },
        {
          text: 'Missing parts',
          style: 'destructive',
          onPress: () => destroy('missing parts — reported from the floor'),
        },
        {
          text: 'Other',
          style: 'destructive',
          onPress: () => destroy('destroyed — reported from the floor'),
        },
      ],
    );
  }

  async function handleSave() {
    const currentLot = lotRef.current;
    const start = editableRef.current;
    if (!currentLot || !start) return;
    if (!start.title.trim()) {
      Alert.alert('Title required', 'Enter a title before saving.');
      return;
    }
    if (role.kind !== 'staff') return;

    // D4: the EditableCandidateCard "+ Add photo" tile can add local file://
    // URIs to stockPhotos. This screen persists photo_urls via a RAW update
    // with NO filterSafeImageUrls guard — so a file:// URI would PERSIST onto
    // the row and render broken forever. Upload any locals to lot-photos and
    // swap them for public URLs BEFORE building the patch; remotes pass
    // through unchanged. (Captured photos added via the inline camera below
    // are already uploaded + persisted at capture time, so by here they're
    // remote and pass straight through.)
    let photoUrls = start.stockPhotos;
    if (photoUrls.some((u) => isLocalPhotoUri(u))) {
      const { urls, failedCount } = await uploadPendingPhotos(
        role.operatorId,
        photoUrls,
        currentLot.lot_code,
      );
      photoUrls = urls;
      if (failedCount > 0) {
        Alert.alert(
          'Some photos didn’t upload',
          `${failedCount} photo${failedCount === 1 ? '' : 's'} couldn’t be uploaded and ${failedCount === 1 ? 'was' : 'were'} left off. The rest will save.`,
        );
      }
    }

    // A background capture may have landed while the uploads above were in
    // flight. Merge those remote URLs in, and read the remaining fields from
    // the latest edit so a title typed during the wait is not overwritten.
    const latest = editableRef.current ?? start;
    photoUrls = mergePhotoUrls(
      photoUrls,
      latest.stockPhotos.filter((u) => !isLocalPhotoUri(u)),
    );

    // The photo list this device loaded is the only safe base for removals.
    // Save must never replace the whole array: another device or a background
    // retry can attach a photo between this load and the update (RED TEAM #683).
    const photoBase = initial?.stockPhotos ?? [];

    // Map EditableCandidate → LotUpdatePatch. Only include fields that
    // make sense to update from this screen — lot_code, status, etc are
    // managed by other workflows. photo_urls is deliberately absent: it is
    // applied as an append/remove delta after the row update.
    const patch = {
      title: latest.title.trim(),
      description: latest.description.trim() || null,
      category: latest.category.trim() || null,
      // editable.condition is `DefaultCondition | ''`. The empty case maps
      // to 'good' (mirrors persistence.ts default-on-empty); otherwise we
      // pass the value through. Cast is safe because DefaultCondition's
      // values are a subset of LotRow['condition'].
      condition: (latest.condition || 'good') as LotRow['condition'],
      msrp_cents: latest.msrpDollars ? parseCents(latest.msrpDollars) : null,
      starting_bid_cents: parseCents(latest.startBidDollars) ?? 100,
    };

    const result = await update(currentLot.id, patch);
    if (result.ok) {
      const photoResult = await applyLotPhotoDelta(
        currentLot.id,
        role.operatorId,
        photoBase,
        photoUrls,
      );
      if (!photoResult.ok) {
        Alert.alert(
          'Details saved, photos not updated',
          `The lot details were saved, but its photos could not be updated (${photoResult.reason}). Pull to refresh and try again.`,
        );
        return;
      }
      Alert.alert('Saved', `${currentLot.lot_code} updated.`);
      // Sync local state to the uploaded URLs so the strip shows remotes
      // (not the now-stale file:// thumbs) and the dirty check resets.
      // Start from `prev`, not `latest`: edits typed while the request was in
      // flight must stay in the editor. Photos merge instead of replace.
      // Locals that were part of this upload are dropped (their remote twins
      // are in `photoUrls`), but a photo captured while the request was
      // pending was never uploaded and must stay visible and unsaved
      // (RED TEAM #683 HIGH).
      setEditable((prev) =>
        prev
          ? {
              ...prev,
              stockPhotos: mergePhotosAfterSave(prev.stockPhotos, start.stockPhotos, photoUrls),
            }
          : prev,
      );
      setLot((prev) =>
        prev
          ? {
              ...prev,
              photo_urls: mergePhotoUrls(
                photoUrls,
                prev.photo_urls.filter((u) => !photoBase.includes(u)),
              ),
            }
          : prev,
      );
      // Refresh the initial snapshot so subsequent edits show as dirty. It
      // holds exactly what was sent, so an edit made during the request still
      // reads as unsaved.
      setInitial((prev) => (prev ? { ...latest, stockPhotos: photoUrls } : prev));
    } else {
      // Translate the few discriminated reasons into friendly copy. The
      // hook returns 'duplicate_external_code' / 'msrp out of range' /
      // 'starting bid out of range' / raw Postgres for everything else.
      const friendly =
        result.reason === 'duplicate_external_code'
          ? 'Another lot already uses this UPC. Clear the external code or pick a different value.'
          : result.reason;
      Alert.alert("Couldn't save changes", friendly);
    }
  }

  // ── Render branches ─────────────────────────────────────────────────────────

  if (role.kind !== 'staff') {
    return null; // staff layout will route us
  }

  if (loading) {
    return (
      <SafeAreaView style={s.centered}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.textMuted, marginTop: 12 }}>Loading lot…</Text>
      </SafeAreaView>
    );
  }

  if (error || !lot || !editable) {
    return (
      <SafeAreaView style={s.centered}>
        <Text style={{ color: colors.danger, fontWeight: '800', fontSize: 14, marginBottom: 8 }}>
          Couldn&apos;t open this lot
        </Text>
        <Text
          style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 16 }}
        >
          {error ?? 'Unknown error'}
        </Text>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>Back to inventory</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={s.header}>
        <View>
          <Text
            style={{
              color: colors.primary,
              fontFamily: 'monospace',
              fontSize: 12,
              fontWeight: '900',
              letterSpacing: 0.5,
            }}
          >
            {lotDisplayCode(lot) ?? lot.lot_code}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
            {lot.status === 'in_inventory' ? 'On shelf' : 'Pending intake'}
            {lot.external_code ? `  ·  ${lot.external_code}` : ''}
          </Text>
          {/* Membership perk 3: white-glove signal for this lot's winning
              bidder. Read-only — tells staff to stage & prep ahead of arrival;
              staging itself is unchanged. */}
          {stagePrep && (
            <View testID="pro-stage-prep-badge" style={s.proBadge}>
              <Text style={s.proBadgeText}>PRO · stage &amp; prep</Text>
            </View>
          )}
        </View>
        <Pressable onPress={() => router.back()} style={s.doneBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>Done</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* QR card up top — operator can show this on screen for the
              picker to scan at intake, or screenshot/print to a thermal
              label. The QR encodes lot_code which the picker's
              intake_lot_to_bin RPC resolves directly. */}
          <LotQRCard lotCode={lot.lot_code} title={lot.title} variant="compact" />
          <Pressable onPress={() => router.push(`/worklist/${lot.id}/label`)} style={s.labelLink}>
            <Text style={s.labelLinkText}>🖨 View printable label →</Text>
          </Pressable>

          {/* Duplicate Lot — for a case of identical items. Copies everything
              except the physical identity (lot code + sticker), then goes
              straight into the sticker prompt for the new box. */}
          <Pressable
            onPress={handleDuplicate}
            disabled={duplicating}
            style={[s.duplicateBtn, duplicating && { opacity: 0.5 }]}
          >
            {duplicating ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={s.duplicateBtnText}>⧉ Duplicate lot — same item, new sticker</Text>
            )}
          </Pressable>

          {/* Scan-recovery. Only while the lot is still on the floor — once it
              reaches an auction or a buyer the RPCs refuse, so we hide the
              controls rather than offer a guaranteed error. */}
          {canFixSticker && (
            <View style={s.fixRow}>
              <Pressable
                onPress={() =>
                  setDupSticker({ lotId: lot.id, lotCode: lot.lot_code, rebind: true })
                }
                disabled={stickerBusy}
                style={[s.fixBtn, stickerBusy && { opacity: 0.5 }]}
              >
                <Text style={s.fixBtnText}>Fix sticker code</Text>
              </Pressable>
              {!!lot.sticker_code && (
                <Pressable
                  onPress={confirmClearSticker}
                  disabled={stickerBusy}
                  style={[s.fixBtn, stickerBusy && { opacity: 0.5 }]}
                >
                  <Text style={s.fixBtnText}>Remove sticker</Text>
                </Pressable>
              )}
              <Pressable
                onPress={confirmDiscardLot}
                disabled={stickerBusy}
                style={[s.fixBtn, s.fixBtnDanger, stickerBusy && { opacity: 0.5 }]}
              >
                <Text style={[s.fixBtnText, { color: colors.danger }]}>Discard lot</Text>
              </Pressable>
            </View>
          )}

          {/* Destroy sits OUTSIDE the sticker-fix row and outside its status
              gate. Those actions are for fixing a lot's identity while it is
              still pre-auction; an item can shatter at any point in its life,
              including one already scheduled. The RPC enforces what actually
              matters — no removal of a lot that carries bids. */}
          {!!lot && (
            <Pressable
              onPress={confirmDestroy}
              disabled={stickerBusy}
              style={[s.fixBtn, s.fixBtnDanger, { marginTop: 8 }, stickerBusy && { opacity: 0.5 }]}
            >
              <Text style={[s.fixBtnText, { color: colors.danger }]}>
                Item destroyed — remove from inventory
              </Text>
            </Pressable>
          )}

          <EditableCandidateCard
            value={editable}
            lotId={lot.id}
            onChange={(patch) => setEditable((prev) => (prev ? { ...prev, ...patch } : prev))}
            onClearPhoto={(i) => {
              if (!editable) return;
              const updated = editable.stockPhotos.filter((_, idx) => idx !== i);
              setEditable({ ...editable, stockPhotos: updated });
            }}
          />

          {/* Inline "+ Add photo" affordance. Opens a small camera
              modal, captures one frame, uploads it to the lot-photos
              bucket, and appends the public URL to editable.stockPhotos.
              The operator still has to tap Save changes for the new
              URL list to land on the DB row. */}
          {!cameraOpen && (
            <Pressable
              onPress={() => {
                if (!hasPermission) {
                  void requestPermission();
                }
                setCameraOpen(true);
              }}
              style={s.addPhotoBtn}
            >
              <Text style={s.addPhotoBtnText}>📷 + Add photo to this lot</Text>
            </Pressable>
          )}

          {photosWaiting === null ? (
            <Text style={s.photosWaiting}>
              📷 Photo upload status unavailable — keep the app open.
            </Text>
          ) : photosWaiting > 0 ? (
            <Text style={s.photosWaiting}>
              📷 {photosWaiting} photo{photosWaiting === 1 ? '' : 's'} waiting to upload
            </Text>
          ) : null}

          {cameraOpen && (
            <View style={s.cameraModal}>
              {hasPermission ? (
                <>
                  <View style={[s.cameraView, { overflow: 'hidden' }]}>
                    {device && (
                      <Camera
                        ref={addPhotoCameraRef}
                        style={{ flex: 1 }}
                        device={device}
                        isActive={cameraGate && cameraOpen}
                        photo={true}
                      />
                    )}
                    <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
                    <CameraFlashButton
                      type="photo"
                      mode={addPhotoFlash}
                      onChange={setAddPhotoFlash}
                      device={device}
                    />
                    {focus.indicator}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8, padding: 10 }}>
                    <Pressable
                      onPress={captureAndAttach}
                      disabled={uploadingPhoto}
                      style={[s.shutterBtn, uploadingPhoto && { opacity: 0.5 }]}
                    >
                      {uploadingPhoto ? (
                        <ActivityIndicator color="#000" />
                      ) : (
                        <Text style={s.shutterBtnText}>⊙ Capture + attach</Text>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={() => setCameraOpen(false)}
                      disabled={uploadingPhoto}
                      style={s.cancelBtn}
                    >
                      <Text style={s.cancelBtnText}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <View style={{ padding: 16, gap: 10 }}>
                  <Text style={{ color: colors.text, fontSize: 14 }}>Camera access required.</Text>
                  <Pressable onPress={() => void requestPermission()} style={s.shutterBtn}>
                    <Text style={s.shutterBtnText}>Allow camera</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}

          <Pressable
            onPress={handleSave}
            disabled={updating || !isDirty || !editable.title.trim()}
            style={[
              s.saveBtn,
              (updating || !isDirty || !editable.title.trim()) && { opacity: 0.4 },
            ]}
          >
            {updating ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={s.saveBtnText}>{isDirty ? 'Save changes' : 'No changes'}</Text>
            )}
          </Pressable>

          {/* "Relist now" — manual trigger for unsold lots. Auto-relist
              runs every 10 min via pg_cron; this button lets staff
              kick it off immediately without waiting. Finds the next
              eligible auction at the same warehouse and calls the
              relist_lot_into_auction RPC. */}
          {lot && lot.status === 'unsold' && (
            <RelistNowSection lot={lot} onDone={() => router.back()} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Sticker prompt for a freshly duplicated lot. Same component the
          lotting screens use for Flow B, so the bind behaves identically —
          including the manager-only skip gate and the success confirmation.
          onCancel leaves the duplicate saved with its auto-generated qr_token
          and no sticker; it is a normal draft and can be stickered later. */}
      {dupSticker && (
        <PreStickeredScanner
          lotId={dupSticker.lotId}
          lotCode={dupSticker.lotCode}
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          rebind={dupSticker.rebind === true}
          onAssigned={() => {
            const { lotCode: code, rebind } = dupSticker;
            const wasRebind = rebind === true;
            setDupSticker(null);
            if (wasRebind) {
              // Same screen, same lot — reflect the new code without a refetch.
              Alert.alert('Sticker updated', `${code} now points at the sticker you just scanned.`);
              setLot((prev) => (prev ? { ...prev } : prev));
            } else {
              // Reported 2026-08-25: "all those items that we lotted under
              // duplicate do not show up in inventory to put on auction."
              // 0326 mints the duplicate 'pending_intake' with no shelf, and
              // the auction builder only lists 'in_inventory' — so a duplicate
              // is NOT auctionable until it is scanned onto a bin. This alert
              // used to say "ready", which is exactly the wrong word: the
              // lotter walked away and the lot sat in the put-away queue
              // unnoticed.
              //
              // Asked where duplicates physically go, the owner said "it may go
              // on same shelf or new shelf" — so neither 0322's silent
              // inheritance nor 0326's blank is right on its own. Ask. The
              // person holding the box is the only one who knows, and same-bin
              // costs them one tap.
              askWhereTheDuplicateWent(code);
            }
          }}
          onCancel={() => {
            const { lotCode: code, rebind } = dupSticker;
            const wasRebind = rebind === true;
            setDupSticker(null);
            if (wasRebind) return; // fixing an existing sticker — nothing changed
            Alert.alert(
              'Duplicate created',
              `${code} was saved without a sticker and without a shelf. Bind a sticker from Inventory and scan it into a bin — it can't be added to an auction until both are done.`,
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

function RelistNowSection({ lot, onDone }: { lot: LotRow; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  async function relistNow() {
    if (!lot.warehouse_id) {
      Alert.alert(
        'Cannot relist',
        'This lot has no warehouse on file — fix that on the operator console first.',
      );
      return;
    }
    setBusy(true);
    try {
      // 0353: no destination auction is chosen here, deliberately. The owner's
      // rule is that nothing is ever auto-scheduled — "every item must remain
      // unscheduled until an employee deliberately chooses an auction and
      // confirms the assignment." This used to grab the soonest-closing
      // auction and commit in the same tap.
      //
      // Passing NULL mints the child 'in_inventory', unattached. Assignment is
      // a separate step through the Auction Builder, which only accepts
      // in_inventory lots (assign_lots_to_auction, mig 0294).
      const { error: rpcErr } = await supabase.rpc('relist_lot_into_auction', {
        p_lot_id: lot.id,
        p_auction_id: null,
        p_lotted_by_worker: getActiveLottingWorkerId(),
      });
      if (rpcErr) throw new Error(rpcErr.message);

      Alert.alert(
        'Relotted to inventory',
        `${lot.lot_code} is back in inventory with a new lot code.\n\nIt is NOT in an auction — it has to be assigned to one deliberately.`,
        [{ text: 'OK', onPress: onDone }],
      );
    } catch (err) {
      Alert.alert('Could not relist', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      style={{
        marginTop: 16,
        padding: 14,
        backgroundColor: 'rgba(248, 113, 113, 0.06)',
        borderWidth: 1,
        borderColor: '#f87171',
        borderRadius: 10,
        gap: 10,
      }}
    >
      <View>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>
          Unsold — ready to relist
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 18 }}>
          This lot closed without a buyer. Auto-relist will move it into your next eligible auction
          within 10 minutes
          {(lot.relist_count ?? 0) > 0 ? ` (relist #${(lot.relist_count ?? 0) + 1})` : ''}. Tap
          below to relist immediately.
        </Text>
      </View>
      <Pressable
        onPress={relistNow}
        disabled={busy}
        style={{
          paddingVertical: 12,
          backgroundColor: busy ? colors.surfaceHi : colors.primary,
          borderRadius: 8,
          alignItems: 'center',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color="#000" />
        ) : (
          <Text style={{ color: '#000', fontWeight: '900', fontSize: 14 }}>Relist now</Text>
        )}
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  doneBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  proBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.winning,
    backgroundColor: colors.winningDim,
  },
  proBadgeText: {
    color: colors.winning,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  fixRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  fixBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  fixBtnDanger: {
    borderColor: `${colors.danger}66`,
  },
  fixBtnText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  duplicateBtn: {
    marginTop: 10,
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.primary}66`,
    backgroundColor: colors.primaryDim,
  },
  duplicateBtnText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  labelLink: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: `${colors.primary}55`,
    backgroundColor: colors.primaryDim,
  },
  labelLinkText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '800',
  },
  saveBtn: {
    padding: 18,
    backgroundColor: '#22c55e',
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  backBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.primary}55`,
  },
  photosWaiting: {
    marginTop: 8,
    fontSize: 13,
    color: colors.textMuted,
  },
  addPhotoBtn: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  addPhotoBtnText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  cameraModal: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cameraView: {
    height: 320,
  },
  shutterBtn: {
    flex: 2,
    padding: 14,
    backgroundColor: colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBtnText: {
    color: '#000',
    fontWeight: '900',
    fontSize: 14,
  },
  cancelBtn: {
    flex: 1,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: colors.textMuted,
    fontWeight: '700',
    fontSize: 13,
  },
});
