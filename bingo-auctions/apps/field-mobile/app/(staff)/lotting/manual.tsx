// LotTR — Manual lot creation screen.
//
// Entry points:
//   - No-match confirmation card in quick.tsx ("Create manual lot" button)
//   - Lotting hub index.tsx tile ("Create manual lot")
//
// Purpose: let the operator build a lot from scratch when no barcode scan
// produced a catalog match and AI identification was not available or
// didn't yield useful data. The form captures the minimum fields needed
// for a clean inventory record: title (required), brand, model, category,
// condition, MSRP, and an optional hero photo.
//
// On save the same post-create sticker flow as quick.tsx fires:
//   lottingMode === 'prestickered' → opens PreStickeredScanner modal.
//   lottingMode === 'generate'     → lot carries its auto-generated QR token.
//
// All JS-only — OTA updatable. No native code changes.

import { useCallback, useRef, useState } from 'react';
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
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import {
  Camera,
  useCameraPermission,
} from 'react-native-vision-camera';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { TAKE_PHOTO_OPTIONS, safeFlash, translateCaptureError } from '@/lib/vision-camera';
import { CameraFlashButton, type FlashMode } from '@/features/lotting/CameraFlashButton';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import * as Haptics from 'expo-haptics';
import {
  createDraftLotFromCandidate,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { supabase, useOperatorRole, hasOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import {
  useLottingSession,
  ALL_CONDITIONS,
  CONDITION_LABELS,
  CONDITION_COLORS,
  type DefaultCondition, activeLotSource } from '@/features/lotting/SessionContext';
import { useLottingMode } from '@/features/lotting/LottingModeContext';
import { lotCreateFailureReport, lotCreateUserMessage } from '@/lib/lot-create-failure';
import { reportNonFatal } from '@/lib/session-watchdog';
import { planStickerBeforeSave, NO_STICKER_SCANNED_TITLE, NO_STICKER_SCANNED_MESSAGE } from '@/lib/sticker-first';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import { bindStickerAfterSave, stickerRefusalCopy } from '@/features/lotting/stickerBindRunner';
import { uploadLotPhotoPublic } from '@/features/lotting/useLotCreation';
import { compressForVision } from '@/lib/image-compress';
import { scrapeProductUrl, cleanScrapeError } from '@/lib/scrape-url';
import { enrichReturnRef } from '@/features/lotting/enrichReturnRef';

// D3: which fields the URL-autofill populated, so we can show a per-field
// "autofilled" chip. Price + condition ALWAYS additionally carry a "verify"
// hint because scraped retail price / condition are not trustworthy enough
// to accept blind — the operator must confirm them.
type AutofilledField = 'title' | 'brand' | 'model' | 'code' | 'msrp' | 'description' | 'photo';

// ── Category options ──────────────────────────────────────────────────────────
// Must match the CATEGORIES tuple in packages/domain-lotting/src/constants.ts
// exactly — LotCandidate['category'] is a discriminated union of those strings.
const CATEGORIES: LotCandidate['category'][] = [
  'Other',
  'Electronics',
  'Appliances',
  'Tools & Hardware',
  'Furniture',
  'Home & Garden',
  'Kitchen',
  'Bath',
  'Bedding & Linens',
  'Clothing',
  'Health & Beauty',
  'Jewelry & Watches',
  'Baby & Kids',
  'Toys & Games',
  'Sporting Goods',
  'Musical Instruments',
  'Crafts & Hobbies',
  'Books & Media',
  'Automotive',
  'Office',
  'Collectibles',
  'Pet Supplies',
];

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ManualLotScreen() {
  const router = useRouter();
  // B2: `prefilledCode` seeds the external_code field. `prefilledSticker`
  // (Pre-stickered no-match hand-off from quick.tsx) is the physical label
  // the operator already scanned — we pre-bind it to the new lot after
  // create so they don't re-scan the same code, while still guaranteeing a
  // sticker is bound (falls back to the scanner if the pre-bind fails).
  const params = useLocalSearchParams<{ prefilledCode?: string; prefilledSticker?: string }>();
  const prefilledSticker = (params.prefilledSticker ?? '').trim();
  const role = useOperatorRole();
  const { session, pushRecentLot } = useLottingSession();
  const { mode: lottingMode } = useLottingMode();
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);

  // Form state
  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [category, setCategory] = useState<LotCandidate['category']>('Other');
  const [condition, setCondition] = useState<DefaultCondition>(session.defaultCondition);
  const [msrpInput, setMsrpInput] = useState('');
  const [externalCode, setExternalCode] = useState(params.prefilledCode ?? '');

  // Photos (camera-captured, local file:// — uploaded on save). Multiple
  // shots supported (Jared recap 2026-07-07: manual lots were single-photo
  // while every other path writes a photo_urls array). First shot = hero.
  const [photoUris, setPhotoUris] = useState<string[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [flashMode, setFlashMode] = useState<FlashMode>('auto');
  const [photoCapturing, setPhotoCapturing] = useState(false);

  // D3 — URL autofill
  const [importUrl, setImportUrl] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importStage, setImportStage] = useState<'reading' | 'searching' | null>(null);
  // Remote (https) product photos pulled from the scrape. Kept separate from
  // the camera photoUri (file://) because these need NO upload — they're
  // already on a retailer CDN and pass createDraftLotFromCandidate's
  // filterSafeImageUrls allowlist. Seeded as candidate.stockPhotos on save.
  const [scrapedPhotoUrls, setScrapedPhotoUrls] = useState<string[]>([]);
  // Which fields the autofill populated (drives the "autofilled" chips).
  const [autofilled, setAutofilled] = useState<Set<AutofilledField>>(new Set());
  const isAutofilled = (f: AutofilledField) => autofilled.has(f);
  // Scraped description text. The manual form has no description input of its
  // own, so we carry the scraped value here and attach it on save (visible
  // on the created lot). Empty when nothing was scraped.
  const [scrapedDescription, setScrapedDescription] = useState('');

  // ── "Try web lookup" round-trip ────────────────────────────────────────────
  //
  // Requested 2026-08-27 (staff report): "We should add a 'Try web lookup'
  // option in manual lot so we do not have to go back into inventory to edit
  // the listing to add a stock image."
  //
  // The URL autofill above only helps when the operator already HAS a product
  // URL. For a hand-typed item they have nothing to paste, so a manual lot was
  // saved photo-less and then re-opened from Inventory later just to attach a
  // stock image — the round trip she is describing.
  //
  // /lotting/web is the screen that can search for a product, and it already
  // supports mode=enrich: rather than creating its own lot it stashes the
  // scraped fields in enrichReturnRef and pops back. QuickLot and the photo
  // review screen both consume it that way; this is the third consumer, so the
  // lot is still created by THIS form's save path — one save, one sticker
  // prompt, no second lot to reconcile.
  //
  // Read-and-clear on focus so a stale payload can never apply twice. Merge is
  // non-destructive: anything the operator already typed wins, because they
  // typed it after seeing the item and the scrape did not.
  useFocusEffect(
    useCallback(() => {
      const payload = enrichReturnRef.current;
      if (!payload) return;
      enrichReturnRef.current = null;

      // Decide everything up front, from the values this render closed over.
      // Nothing below mutates inside a state updater: updaters must stay pure
      // (StrictMode runs them twice), and a Set built by side effect there
      // would double-count or come back empty depending on the run.
      const filled = new Set<AutofilledField>();

      const nextTitle = payload.title.trim();
      const takeTitle = nextTitle !== '' && title.trim() === '';
      if (takeTitle) filled.add('title');

      const nextMsrp = payload.msrpDollars.trim();
      const takeMsrp = nextMsrp !== '' && msrpInput.trim() === '';
      if (takeMsrp) filled.add('msrp');

      const nextDescription = payload.description.trim();
      const takeDescription = nextDescription !== '' && scrapedDescription === '';
      if (takeDescription) filled.add('description');

      // Photos are the whole point of the request, so these MERGE rather than
      // defer: a stock image is additive to whatever the operator shot.
      const scraped = [
        ...(payload.photoUrl ? [payload.photoUrl] : []),
        ...payload.extraPhotoUrls,
      ]
        .map((u) => u.trim())
        .filter(Boolean);
      if (scraped.length > 0) filled.add('photo');

      if (takeTitle) setTitle(nextTitle);
      if (takeMsrp) setMsrpInput(nextMsrp);
      if (takeDescription) setScrapedDescription(nextDescription);
      if (scraped.length > 0) {
        setScrapedPhotoUrls((prev) => Array.from(new Set([...scraped, ...prev])));
      }
      if (filled.size > 0) {
        setAutofilled((prev) => new Set([...prev, ...filled]));
      }
    }, [title, msrpInput, scrapedDescription]),
  );

  /** Hand off to the web-lookup screen seeded with whatever the form knows. */
  const onTryWebLookup = useCallback(() => {
    router.push({
      pathname: '/lotting/web',
      params: {
        prefilledTitle: title.trim(),
        prefilledCode: externalCode.trim(),
        // Enrich, don't create — this form still owns the save.
        mode: 'enrich',
      },
    });
  }, [router, title, externalCode]);

  // Submission
  const [creating, setCreating] = useState(false);
  const creatingLockRef = useRef(false);

  // Post-create sticker flow
  const [pendingSticker, setPendingSticker] = useState<{ lotId: string; lotCode: string } | null>(null);
  // Sticker before save (2026-10-05): the capture scanner runs first in
  // Pre-stickered mode; the value it returns is bound right after the save.
  const [captureSticker, setCaptureSticker] = useState(false);
  const capturedStickerRef = useRef<string | null>(null);

  // ── URL autofill (D3) ───────────────────────────────────────────────────────
  //
  // Optional accelerator: paste a product URL, tap Autofill, and the form
  // pre-fills from the scrape. NEVER blocks manual entry — the operator can
  // ignore this block entirely and type every field. Reuses the SAME shared
  // two-stage scrapeProductUrl helper as web.tsx ("Reading the page…" →
  // on needs_fallback "Site blocks direct reads — searching the web…").
  const onAutofillFromUrl = useCallback(async () => {
    const trimmed = importUrl.trim();
    if (!trimmed) {
      Alert.alert('Paste a URL', 'Drop in any product page URL — major retailers read directly; anything else goes through web search. Then tap Autofill.');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      Alert.alert('Not a URL', "That doesn't look like a URL — copy the full https://… link from the retailer's page.");
      return;
    }
    setImportBusy(true);
    setImportStage('reading');
    try {
      const result = await scrapeProductUrl(trimmed, (stage) => setImportStage(stage));
      if ('noSession' in result && result.noSession) {
        Alert.alert('Session expired', 'Sign out and back in, then try again.');
        return;
      }
      if (!result.ok) {
        Alert.alert(
          "Couldn't read that page",
          `${cleanScrapeError(result.error)}\n\nNo problem — just fill the fields below by hand.`,
        );
        return;
      }

      const d = result.data;
      const filled = new Set<AutofilledField>();
      if (d.title) {
        setTitle(d.title.slice(0, 500));
        filled.add('title');
      }
      if (d.brand) {
        setBrand(d.brand);
        filled.add('brand');
      }
      // The contract has no `model` field; use the scraped identifier (UPC
      // preferred, else ASIN) for the barcode/code field so intake-scan can
      // resolve it later. Don't clobber a code the operator already typed.
      const scrapedCode = (d.upc || d.asin || '').trim();
      if (scrapedCode && !externalCode.trim()) {
        setExternalCode(scrapedCode);
        filled.add('code');
      }
      if (d.msrp_cents && d.msrp_cents > 0) {
        setMsrpInput((d.msrp_cents / 100).toFixed(2));
        filled.add('msrp'); // always paired with a "verify" hint in the UI
      }
      if (d.description) {
        // Manual form has no description field of its own — fold any scraped
        // description into… nothing yet. Track it so the chip shows, and stash
        // it on the candidate at save time via the notes/description path.
        filled.add('description');
      }
      // Remote product photos — primary first, then additional, de-duped.
      const photos = Array.from(
        new Set(
          [
            ...(d.primary_image_url ? [d.primary_image_url] : []),
            ...(Array.isArray(d.additional_image_urls) ? d.additional_image_urls : []),
          ]
            .map((u) => (u ?? '').trim())
            .filter(Boolean),
        ),
      );
      if (photos.length > 0) {
        setScrapedPhotoUrls(photos);
        filled.add('photo');
      }
      // Stash description text so saveLot can attach it (the form itself has
      // no description input; we keep the scraped text in a ref-free state).
      setScrapedDescription(d.description?.trim() || '');

      setAutofilled(filled);
      const sourceNote = result.source === 'ai_fallback' ? ' · found via web search' : '';
      const warn = result.warnings.length ? ` (${result.warnings.join(', ')})` : '';
      Alert.alert(
        'Autofilled',
        `Filled from ${result.host}${sourceNote}${warn}. Review every field — price and condition especially need your confirmation.`,
      );
      setImportUrl('');
    } catch (err) {
      Alert.alert("Couldn't autofill", (err as Error).message);
    } finally {
      setImportBusy(false);
      setImportStage(null);
    }
  }, [importUrl, externalCode]);

  // ── Photo capture ─────────────────────────────────────────────────────────

  const capturePhoto = useCallback(async () => {
    if (!cameraRef.current || photoCapturing) return;
    setPhotoCapturing(true);
    try {
      const photo = await cameraRef.current.takePhoto({
        flash: safeFlash(device, flashMode),
        ...TAKE_PHOTO_OPTIONS,
      });
      const uri = `file://${photo.path}`;
      // Append (multi-photo) and STAY in the camera so the operator can keep
      // shooting angles; "Done" returns to the form.
      setPhotoUris((prev) => [...prev, uri]);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      Alert.alert('Photo failed', translateCaptureError(err));
    } finally {
      setPhotoCapturing(false);
    }
  }, [photoCapturing, flashMode, device]);

  // ── Save lot ──────────────────────────────────────────────────────────────

  const saveLot = useCallback(async () => {
    if (role.kind !== 'staff') {
      Alert.alert('Not signed in as staff');
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      Alert.alert('Title required', 'Add a title before saving the lot.');
      return;
    }
    // Sticker before save: no sticker in hand means the scanner, not a save.
    const stickerPlan = planStickerBeforeSave({
      mode: lottingMode,
      prefilledSticker,
      capturedSticker: capturedStickerRef.current,
    });
    if (stickerPlan.action === 'scan_first') {
      setCaptureSticker(true);
      return;
    }
    const stickerToBind = stickerPlan.sticker ?? '';
    capturedStickerRef.current = null;
    if (creatingLockRef.current) return;
    creatingLockRef.current = true;
    setCreating(true);

    try {
      const msrp = (() => {
        const v = parseFloat(msrpInput);
        return Number.isFinite(v) && v > 0 ? v : null;
      })();

      const candidate: LotCandidate = {
        title: trimmedTitle.slice(0, 500),
        fullTitle: trimmedTitle,
        brand: brand.trim(),
        model: model.trim(),
        // externalCode from params (the scanned barcode) becomes the lot's
        // external_code so intake-scan can resolve it later. Empty → null
        // path handled by createDraftLotFromCandidate (normalizes empty upc).
        upc: externalCode.trim(),
        category,
        subcategory: '',
        packagingMsrp: null,
        condition: condition as LotCandidate['condition'],
        // D3: attach any scraped description. createDraftLotFromCandidate
        // truncates to the DB CHECK length; empty stays empty.
        description: scrapedDescription.trim(),
        searchQuery: '',
        confidence: 'low',
        notes: '',
        prices: [],
        // D3: seed remote (https) scraped photos. These are retailer-CDN URLs
        // — filterSafeImageUrls in persistence.ts drops any off-allowlist host,
        // and there are no file:// URIs here (the camera photoUri uploads
        // separately below), so nothing local can leak into photo_urls.
        stockPhotos: scrapedPhotoUrls,
        msrp,
        avg: null,
        startBid: session.defaultStartBid,
        specs: '',
      };

      const out = await createDraftLotFromCandidate(supabase, {
        candidate,
        operatorId: role.operatorId,
        source: activeLotSource(session) || null,
        vendor: session.defaultVendor || null,
      });

      if (!out.ok) {
        // Plain cause + the server's own words, and a server-side record of
        // the failure (2026-10-05: the generic sentence hid a real error).
        reportNonFatal(
          lotCreateFailureReport(out, { screen: '/lotting/manual', lottingMode }),
        );
        const { title: alertTitle, message: userMessage } = lotCreateUserMessage(out);
        Alert.alert(alertTitle, userMessage);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const lotIdSnap = out.lotId;
      const lotCodeSnap = out.lotCode;
      const operatorIdSnap = role.operatorId;

      // Background enrichment (cache write-through) — fire-and-forget.
      void out.enrich();

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      pushRecentLot({
        lotId: lotIdSnap,
        lotCode: lotCodeSnap,
        externalCode: externalCode.trim() || lotCodeSnap,
        title: candidate.title,
        ...(activeLotSource(session) ? { source: activeLotSource(session) } : {}),
      });

      // Photo uploads if any were captured. The lot was already created with
      // any scraped (remote) photos in photo_urls via
      // createDraftLotFromCandidate; the scraped stock photos lead (primary
      // listing image) and the captures follow — so we DON'T clobber them.
      //
      // DATA-LOSS FIX + hardening (kept from the single-photo version): the
      // upload used to be fire-and-forget with an empty catch that SILENTLY
      // dropped the photo on RLS rejection. We await every upload via
      // uploadLotPhotoPublic (which re-resolves the operator id the server's
      // current_operator_id() expects) and surface a visible Alert when any
      // shot fails instead of a clean success.
      if (photoUris.length > 0) {
        for (const uri of photoUris) void compressForVision(uri).catch(() => undefined);
        const uploads = await Promise.all(
          photoUris.map((uri) =>
            uploadLotPhotoPublic(operatorIdSnap, lotCodeSnap, uri).catch(
              (err: unknown) =>
                ({ ok: false as const, reason: (err as Error)?.message ?? 'upload failed' }),
            ),
          ),
        );
        const uploadedUrls = uploads.flatMap((u) => (u.ok ? [u.url] : []));
        const failedCount = uploads.length - uploadedUrls.length;
        if (uploadedUrls.length > 0) {
          // Imported stock photos lead (primary listing image — tester recap
          // 2026-07-08), then the operator's captures in shot order.
          const { error: patchErr } = await supabase
            .from('lots')
            .update({ photo_urls: [...scrapedPhotoUrls, ...uploadedUrls] })
            .eq('id', lotIdSnap);
          if (patchErr) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            Alert.alert(
              'Photos saved but not linked',
              `Lot ${lotCodeSnap} was created and the photos uploaded, but linking them to the lot failed: ${patchErr.message.slice(0, 80)}. Add them again from Inventory.`,
            );
          } else if (failedCount > 0) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            Alert.alert(
              'Some photos didn’t save',
              `Lot ${lotCodeSnap} saved with ${uploadedUrls.length} photo${uploadedUrls.length === 1 ? '' : 's'}, but ${failedCount} failed to upload. Add the rest from Inventory.`,
            );
          }
        } else {
          const firstFail = uploads.find((u) => !u.ok);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Alert.alert(
            "Photos didn't save",
            `Lot ${lotCodeSnap} was created, but its photos couldn't be uploaded (${firstFail && !firstFail.ok ? firstFail.reason : 'upload failed'}). The lot saved WITHOUT them — add photos from Inventory.`,
          );
        }
      }

      // Pre-stickered flow B — mirror of quick.tsx behaviour.
      if (lottingMode !== 'generate') {
        // B2: if quick.tsx handed us a prefilledSticker (the code the
        // operator already scanned on the no-match path), pre-bind it now so
        // they don't have to scan the same label a second time. Routing is
        // by value inside bindStickerToLot (UUID → qr_token; else →
        // sticker_code), identical to quick.tsx's single-scan auto-bind.
        if (stickerToBind) {
          // NOT awaited (2026-10-08): the save spinner used to wait on this
          // request with no limit. Time-boxed; a network failure is kept on
          // the phone and retried. This screen closes now, so a refusal
          // (sticker already on another lot) is reported by alert instead of
          // this screen's scanner.
          void bindStickerAfterSave({ lotId: lotIdSnap, lotCode: lotCodeSnap, sticker: stickerToBind }).then(
            (outcome) => {
              if (outcome.kind !== 'refused') return;
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              Alert.alert(
                'Sticker not bound',
                `${stickerRefusalCopy(outcome.reason)}\n\nLot ${lotCodeSnap} was created, but the sticker is NOT attached yet. Open ${lotCodeSnap} in Inventory and scan a sticker.`,
              );
            },
          );
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('Lot created', `${lotCodeSnap} — sticker scanned, attaching now.`);
          router.back();
          return;
        } else {
          // No pre-bind hand-off — open the scanner as before.
          setPendingSticker({ lotId: lotIdSnap, lotCode: lotCodeSnap });
        }
      } else {
        // Generate mode: go back immediately; the hub toast will be absent
        // (we don't thread back a callback) but the lot is in Inventory.
        router.back();
      }
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn't create lot", (err as Error).message);
    } finally {
      setCreating(false);
      creatingLockRef.current = false;
    }
  }, [
    role,
    title,
    brand,
    model,
    category,
    condition,
    msrpInput,
    externalCode,
    photoUris,
    scrapedDescription,
    scrapedPhotoUrls,
    // `session` covers defaultStartBid / defaultVendor / the load-aware
    // source label, so the individual field deps would only be redundant.
    session,
    lottingMode,
    prefilledSticker,
    pushRecentLot,
    router,
  ]);

  // ── Camera permission gate ────────────────────────────────────────────────

  if (showCamera && !hasPermission) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: 24 }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 16 }}>
          Camera access is required to add a photo.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 16, backgroundColor: colors.primary, borderRadius: 12 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800' }}>
            Allow camera
          </Text>
        </Pressable>
        <Pressable onPress={() => setShowCamera(false)} style={{ marginTop: 12, alignItems: 'center' }}>
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Cancel</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // ── Camera capture view ───────────────────────────────────────────────────

  if (showCamera) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={{ flex: 1, position: 'relative' }}>
          {device ? (
            <Camera
              ref={cameraRef}
              style={StyleSheet.absoluteFillObject}
              device={device}
              isActive={!pendingSticker && !captureSticker}
              photo={true}
            />
          ) : (
            <View style={[StyleSheet.absoluteFillObject, { alignItems: 'center', justifyContent: 'center' }]}>
              <ActivityIndicator color={colors.primary} />
            </View>
          )}
          <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
          <CameraFlashButton type="photo" mode={flashMode} onChange={setFlashMode} device={device} />
          {focus.indicator}
        </View>
        <View style={{ padding: 20, gap: 10 }}>
          <Pressable
            onPress={capturePhoto}
            disabled={photoCapturing || !device}
            style={[
              s.shutterBtn,
              (photoCapturing || !device) && { opacity: 0.5 },
            ]}
          >
            {photoCapturing ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={{ color: '#000', fontSize: 16, fontWeight: '900', textAlign: 'center' }}>
                {photoUris.length === 0
                  ? 'Take photo'
                  : `Take another (${photoUris.length} so far)`}
              </Text>
            )}
          </Pressable>
          <Pressable onPress={() => setShowCamera(false)} style={s.cancelPhotoBtn}>
            <Text style={{ color: colors.textMuted, fontSize: 14, fontWeight: '700', textAlign: 'center' }}>
              {photoUris.length === 0
                ? 'Cancel'
                : `Done — use ${photoUris.length} photo${photoUris.length === 1 ? '' : 's'}`}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Form view ─────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={s.header}>
        <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '900', flex: 1 }}>
          Manual lot
        </Text>
        <Pressable onPress={() => router.back()} style={s.cancelBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 100 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── D3: Paste product URL → Autofill (optional accelerator) ──────── */}
        {/* Sits ABOVE Title. Purely optional — the operator can ignore it and
            type every field by hand. On success it pre-fills the fields below
            and marks each with an "autofilled" chip. */}
        <View style={[s.autofillCard]}>
          <Text style={[s.fieldLabel, { color: '#22c55e' }]}>⚡ Paste product URL → Autofill</Text>
          <TextInput
            value={importUrl}
            onChangeText={setImportUrl}
            placeholder="https://… product page (long-press → Paste)"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!importBusy}
            style={s.textInput}
          />
          <Pressable
            onPress={onAutofillFromUrl}
            disabled={importBusy || !importUrl.trim()}
            style={[
              s.autofillBtn,
              {
                backgroundColor: importUrl.trim() && !importBusy ? '#22c55e' : colors.surface,
                borderColor: importUrl.trim() && !importBusy ? '#22c55e' : colors.border,
              },
            ]}
          >
            {importBusy ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={{ color: importUrl.trim() ? '#000' : colors.textMuted, fontWeight: '900', fontSize: 14 }}>
                Autofill
              </Text>
            )}
          </Pressable>
          {importStage ? (
            <Text style={{ color: '#22c55e', fontSize: 12, fontWeight: '700' }}>
              {importStage === 'reading'
                ? 'Reading the page…'
                : 'Site blocks direct reads — searching the web…'}
            </Text>
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16 }}>
              Optional. Fills Title, brand, code, price, description, and photos from the page.
              You can also just type everything below. Always confirm price &amp; condition.
            </Text>
          )}

          {/* Staff report 2026-08-27: the Autofill above needs a URL you already
              have. With nothing to paste, a hand-typed lot used to be saved
              photo-less and re-opened from Inventory later just to attach a
              stock image. This searches for the product instead and comes back
              with the image; the lot is still created by this form. */}
          <Pressable
            onPress={onTryWebLookup}
            disabled={importBusy}
            style={s.webLookupBtn}
            accessibilityRole="button"
            accessibilityLabel="Try web lookup"
            accessibilityHint="Search the web for this product and bring back its stock photo and details"
          >
            <Text style={s.webLookupBtnText}>
              🔎 No URL? Try web lookup{title.trim() ? ` for “${title.trim()}”` : ''}
            </Text>
          </Pressable>
        </View>

        {/* Title — required */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>
              Title <Text style={{ color: '#dc2626' }}>*</Text>
            </Text>
            {isAutofilled('title') && <AutofillChip />}
          </View>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Dyson V11 Cordless Vacuum"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="words"
            style={s.textInput}
            returnKeyType="next"
            maxLength={500}
          />
        </View>

        {/* Brand */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>Brand</Text>
            {isAutofilled('brand') && <AutofillChip />}
          </View>
          <TextInput
            value={brand}
            onChangeText={setBrand}
            placeholder="e.g. Dyson"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="words"
            style={s.textInput}
            returnKeyType="next"
            maxLength={120}
          />
        </View>

        {/* Model */}
        <View>
          <Text style={s.fieldLabel}>Model</Text>
          <TextInput
            value={model}
            onChangeText={setModel}
            placeholder="e.g. V11 Torque Drive"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="characters"
            style={s.textInput}
            returnKeyType="next"
            maxLength={120}
          />
        </View>

        {/* External code (pre-filled from no-match scan or URL autofill) */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>Barcode / code (optional)</Text>
            {isAutofilled('code') && <AutofillChip />}
          </View>
          <TextInput
            value={externalCode}
            onChangeText={setExternalCode}
            placeholder="UPC, ASIN, FNSKU, or leave blank"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="characters"
            style={[s.textInput, { fontFamily: 'monospace' }]}
            returnKeyType="next"
            maxLength={100}
          />
        </View>

        {/* Category */}
        <View>
          <Text style={s.fieldLabel}>Category</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            {CATEGORIES.map((cat) => {
              const isActive = category === cat;
              return (
                <Pressable
                  key={cat}
                  onPress={() => setCategory(cat)}
                  style={[
                    s.chip,
                    isActive && {
                      backgroundColor: 'rgba(255,122,0,0.15)',
                      borderColor: `${colors.primary}88`,
                    },
                  ]}
                >
                  <Text style={[s.chipText, isActive && { color: colors.primary }]}>
                    {cat}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Condition */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>Condition</Text>
            {/* D3: condition is NEVER auto-set from a scrape (item_condition is
                unreliable). After any autofill, nudge the operator to confirm
                it explicitly. */}
            {autofilled.size > 0 && <VerifyChip />}
          </View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {ALL_CONDITIONS.map((cond: DefaultCondition) => {
              const isActive = condition === cond;
              const col = CONDITION_COLORS[cond];
              return (
                <Pressable
                  key={cond}
                  onPress={() => setCondition(cond)}
                  style={[
                    s.chip,
                    isActive && {
                      backgroundColor: `${col}22`,
                      borderColor: `${col}66`,
                    },
                  ]}
                >
                  <Text style={[s.chipText, isActive && { color: col }]}>
                    {CONDITION_LABELS[cond]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* MSRP */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>MSRP ($) — optional</Text>
            {/* D3: scraped price is filled but ALWAYS flagged for confirmation
                — retail/list prices off a page are frequently wrong or stale. */}
            {isAutofilled('msrp') && (
              <>
                <AutofillChip />
                <VerifyChip />
              </>
            )}
          </View>
          <TextInput
            value={msrpInput}
            onChangeText={setMsrpInput}
            placeholder="0.00"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            style={[s.textInput, { width: 120 }]}
            returnKeyType="done"
          />
        </View>

        {/* Photos — multiple supported; first shot is the hero */}
        <View>
          <View style={s.labelRow}>
            <Text style={s.fieldLabel}>Photos — optional</Text>
            {isAutofilled('photo') && <AutofillChip />}
          </View>
          {/* D3: scraped product photos (remote) attach on save. Camera
              shots lead (first = hero) and the scraped ones follow. */}
          {scrapedPhotoUrls.length > 0 && (
            <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6 }}>
              {scrapedPhotoUrls.length} product photo{scrapedPhotoUrls.length === 1 ? '' : 's'} from the page will be attached.
              {photoUris.length > 0 ? ' Your camera shots lead, first one is the main photo.' : ''}
            </Text>
          )}
          {photoUris.length > 0 ? (
            <View style={{ gap: 8 }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {photoUris.map((uri, idx) => (
                  <View key={uri} style={{ position: 'relative' }}>
                    <Image
                      source={{ uri }}
                      style={{ width: 110, height: 110, borderRadius: 10, resizeMode: 'cover' }}
                    />
                    {idx === 0 && (
                      <View style={s.heroTag}>
                        <Text style={s.heroTagText}>MAIN</Text>
                      </View>
                    )}
                    <Pressable
                      onPress={() =>
                        setPhotoUris((prev) => prev.filter((u) => u !== uri))
                      }
                      hitSlop={8}
                      style={s.photoRemoveBtn}
                    >
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>✕</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
              <Pressable onPress={() => setShowCamera(true)} style={s.addPhotoBtn}>
                <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                  Add more photos
                </Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setShowCamera(true)} style={s.addPhotoBtn}>
              <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                Add photos
              </Text>
            </Pressable>
          )}
        </View>

        {/* Save */}
        <Pressable
          onPress={saveLot}
          disabled={creating || !title.trim()}
          style={[
            s.saveBtn,
            (creating || !title.trim()) && { opacity: 0.5 },
          ]}
        >
          {creating ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={s.saveBtnText}>Save lot</Text>
          )}
        </Pressable>
      </ScrollView>

      {captureSticker && (
        <PreStickeredScanner
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          onAssigned={() => {}}
          onCancel={() => {}}
          capture={{
            onCaptured: (sticker) => {
              capturedStickerRef.current = sticker;
              setCaptureSticker(false);
              setTimeout(() => void saveLot(), 0);
            },
            onAbort: () => {
              setCaptureSticker(false);
              Alert.alert(NO_STICKER_SCANNED_TITLE, NO_STICKER_SCANNED_MESSAGE);
            },
          }}
        />
      )}
      {pendingSticker && (
        <PreStickeredScanner
          lotId={pendingSticker.lotId}
          lotCode={pendingSticker.lotCode}
          // C2: manager-only sticker skip. `role` from useOperatorRole();
          // narrow to 'staff' before reading role.role.
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          // Black-screen fix (staff report 2026-07-10): dismiss the
          // full-screen scanner modal FIRST, then pop on the next tick.
          // Calling router.back() in the same tick as setPendingSticker(null)
          // raced the modal teardown against the route pop — useIsFocused()
          // flipped the camera dead while the modal was still the top iOS
          // surface, leaving a black screen only a force-close cleared.
          onAssigned={() => {
            setPendingSticker(null);
            setTimeout(() => router.back(), 0);
          }}
          onCancel={() => {
            setPendingSticker(null);
            setTimeout(() => router.back(), 0);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ── D3 field affordances ────────────────────────────────────────────────────────

/** Small green chip marking a field the URL-autofill populated. */
function AutofillChip() {
  return (
    <View style={s.autofillTag}>
      <Text style={s.autofillTagText}>autofilled</Text>
    </View>
  );
}

/** Amber chip telling the operator this field MUST be confirmed before save
 *  (price / condition). Pairs with AutofillChip on MSRP. */
function VerifyChip() {
  return (
    <View style={s.verifyTag}>
      <Text style={s.verifyTagText}>verify</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  // D3: a label row that can hold the field label plus autofilled/verify chips.
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  autofillCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.35)',
    backgroundColor: 'rgba(34,197,94,0.06)',
    gap: 10,
  },
  autofillBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  webLookupBtn: {
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.4)',
    backgroundColor: 'transparent',
    alignItems: 'center',
  },
  webLookupBtnText: {
    color: '#22c55e',
    fontWeight: '800',
    fontSize: 13,
  },
  autofillTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(34,197,94,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.4)',
    // Pull the chip's baseline up to align with the uppercase label.
    marginBottom: 6,
  },
  autofillTagText: {
    color: '#22c55e',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  verifyTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.45)',
    marginBottom: 6,
  },
  verifyTagText: {
    color: '#f59e0b',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
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
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  addPhotoBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  // Multi-photo strip affordances
  heroTag: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  heroTagText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(220,38,38,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    marginTop: 6,
  },
  saveBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  shutterBtn: {
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: colors.primary,
  },
  cancelPhotoBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
});
