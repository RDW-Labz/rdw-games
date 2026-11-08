// LotTR — Web Lookup (manual data scrape) screen.
//
// The third option on the lotting hub alongside AI Photo Scan + Quick Lot.
// Two flows live here:
//
// A. ONE-CLICK IMPORT (added 2026-05-21) — operator finds the item on
//    Amazon/eBay/Google Shopping, copies the product URL, pastes it
//    here, taps "Import". The /api/lottr/scrape-url endpoint scrapes
//    the JSON-LD block + DOM fallbacks and returns structured data.
//    W2-rest: import-review.tsx deleted; scraped data now pre-fills
//    the form below inline. Operator reviews, optionally edits, and
//    taps Create from the same screen.
//
//    Phase 2 (next EAS build) replaces the paste step with an iOS
//    Share Extension via expo-share-intent — true one-tap from the
//    Amazon page's share sheet. Both flows POST to the same scraper
//    endpoint so the contract stays stable.
//
// B. MANUAL ESCAPE HATCH (the original flow) — type a search term,
//    open the retailer in mobile Safari, copy bits manually, paste
//    into the form fields below, hit Create. Still available for cases
//    where the scraper fails (login walls, A/B'd HTML).
//
// All data ends up in the same `lots` table, normalized and indexed
// alongside the other creation paths.

import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  SafeAreaView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase, useOperatorRole, hasOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { parseCents, isSafeImageUrl, getActiveLottingLoadId } from '@auction-platform/domain-lotting';
import { enrichReturnRef } from '@/features/lotting/enrichReturnRef';
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
import { bindStickerAfterSave, stickerRefusalCopy } from '@/features/lotting/stickerBindRunner';
import { LottingModeToggle } from '@/features/lotting/LottingModeToggle';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import { scrapeProductUrl, cleanScrapeError } from '@/lib/scrape-url';

export default function WebLookupScreen() {
  const router = useRouter();
  const role = useOperatorRole();
  const { session, pushRecentLot } = useLottingSession();

  const [searchQuery, setSearchQuery] = useState('');
  const [title, setTitle] = useState('');
  const [msrpDollars, setMsrpDollars] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [description, setDescription] = useState('');
  const [condition, setCondition] = useState<DefaultCondition>(session.defaultCondition);
  const [busy, setBusy] = useState(false);

  // Pre-stickered Flow B: after a lot is created we may need to capture
  // a sticker scan. Holds the lot we just minted; non-null = show the
  // scanner modal. The lot itself is already persisted with an auto-gen
  // qr_token, so dismissing the scanner is a safe no-op fallback.
  const { mode: lottingMode } = useLottingMode();
  const [pendingSticker, setPendingSticker] = useState<{ lotId: string; lotCode: string } | null>(null);
  // Sticker before save (2026-10-05): capture first, bind right after the insert.
  const [captureSticker, setCaptureSticker] = useState(false);
  const capturedStickerRef = useRef<string | null>(null);

  // Add-Missing-Data (update-in-place) mode: set when this screen is opened
  // from an EXISTING lot's review card (prefilledLotId). When non-null,
  // onCreate UPDATES that lot instead of minting a new one, and the stock
  // photo is prepended to the lot's existing inspection photos. existingPhotos
  // mirrors the lot's current photo_urls (loaded below) for that merge.
  const [updateLotId, setUpdateLotId] = useState<string | null>(null);
  const [existingPhotos, setExistingPhotos] = useState<string[]>([]);
  const lotLoadedRef = useRef(false);

  // One-click import flow state
  const [importUrl, setImportUrl] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  // W2-rest: import-review.tsx was deleted. After a successful scrape we
  // now pre-fill the form below inline instead of navigating away.
  const [importedBanner, setImportedBanner] = useState<string | null>(null);
  // D1-client: two-stage progress copy. null while idle; 'reading' for the
  // fast direct attempt, 'searching' once the server signals needs_fallback
  // and we retry with allowAiFallback. Drives the inline status line + button
  // label so the operator sees WHY a blocked site takes a few extra seconds.
  const [importStage, setImportStage] = useState<'reading' | 'searching' | null>(null);
  // Extra hero photos the scrape returned beyond primary_image_url. Carried
  // onto the created lot's photo_urls (primary stays photo_urls[0]).
  const [extraPhotoUrls, setExtraPhotoUrls] = useState<string[]>([]);

  // Route params arrive from three entry points, all previously dropped
  // except prefilledUrl/scrapeError:
  //   - iOS Share Extension SUCCESS (handleShareIntent → 'navigate'):
  //     prefilledData (JSON of the scraped ScrapedData), host, warnings,
  //     prefilledUrl.
  //   - iOS Share Extension FAILURE ('fallback'): prefilledUrl + scrapeError.
  //   - Review-card / confirmation "Try web lookup" (EditableCandidateCard
  //     :357-359, quick.tsx onWebLookup): prefilledTitle + prefilledCode.
  // B3: hydrate the form from ALL of them so the Share-Extension success
  // payload and the review-card context are no longer silently lost.
  const params = useLocalSearchParams<{
    prefilledUrl?: string;
    scrapeError?: string;
    prefilledData?: string;
    host?: string;
    warnings?: string;
    prefilledTitle?: string;
    prefilledCode?: string;
    prefilledLotId?: string;
    // mode=enrich → QuickLot inline enrichment: return the scraped data to the
    // QuickLot candidate instead of creating (or updating) a lot.
    mode?: string;
  }>();
  const isEnrichMode = params.mode === 'enrich';
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    const prefilled = typeof params.prefilledUrl === 'string' ? params.prefilledUrl : '';
    const err = typeof params.scrapeError === 'string' ? params.scrapeError : '';
    const dataJson = typeof params.prefilledData === 'string' ? params.prefilledData : '';
    const pTitle = typeof params.prefilledTitle === 'string' ? params.prefilledTitle : '';
    const pCode = typeof params.prefilledCode === 'string' ? params.prefilledCode : '';
    const pLotId = typeof params.prefilledLotId === 'string' ? params.prefilledLotId : '';
    if (!prefilled && !err && !dataJson && !pTitle && !pCode) return;
    hydratedRef.current = true;

    if (prefilled) setImportUrl(prefilled);
    if (err) {
      Alert.alert(
        "Couldn't import from share",
        err.includes(' — ') ? (err.split(' — ')[1] ?? err) : err,
      );
    }

    // Share-Extension SUCCESS payload: pre-fill the form from the scraped
    // ScrapedData (same shape the inline paste-URL path produces). Mirrors
    // onImportFromUrl's field mapping so both flows behave identically.
    if (dataJson) {
      try {
        const d = JSON.parse(dataJson) as {
          title?: string;
          msrp_cents?: number | null;
          primary_image_url?: string | null;
          additional_image_urls?: string[];
          description?: string | null;
          brand?: string | null;
          upc?: string | null;
          asin?: string | null;
          item_condition?: string | null;
        };
        if (d.title) setTitle(d.title);
        if (d.msrp_cents && d.msrp_cents > 0) {
          setMsrpDollars((d.msrp_cents / 100).toFixed(2));
        }
        if (d.primary_image_url) setPhotoUrl(d.primary_image_url);
        const descParts: string[] = [];
        if (d.description) descParts.push(d.description);
        if (d.brand) descParts.push(`Brand: ${d.brand}`);
        if (d.upc) descParts.push(`UPC: ${d.upc}`);
        if (d.asin) descParts.push(`ASIN: ${d.asin}`);
        if (descParts.length) setDescription(descParts.join('\n'));
        const host = typeof params.host === 'string' && params.host ? params.host : 'shared page';
        const warns =
          typeof params.warnings === 'string' && params.warnings ? ` (${params.warnings})` : '';
        setImportedBanner(`Imported from ${host}${warns} — review below and tap Create`);
      } catch {
        // Malformed payload — fall through; the operator can still paste a
        // URL or fill the form manually.
      }
    }

    // Review-card "Try web lookup": seed the title + a search query so the
    // Google/Amazon/eBay buttons are immediately useful. The scanned code
    // (UPC/ASIN) seeds the search when there's no title, and is kept in the
    // description for visibility on the created lot.
    if (pTitle && !dataJson) setTitle(pTitle);
    if ((pTitle || pCode) && !dataJson) {
      setSearchQuery(pTitle || pCode);
    }
    // Update-in-place mode loads the lot's real description below — don't seed
    // the "Code:" placeholder there or it could shadow an existing description.
    if (pCode && !dataJson && !pLotId) {
      setDescription((prev) => (prev ? prev : `Code: ${pCode}`));
    }
  }, [
    params.prefilledUrl,
    params.scrapeError,
    params.prefilledData,
    params.host,
    params.warnings,
    params.prefilledTitle,
    params.prefilledCode,
    params.prefilledLotId,
  ]);

  // Update-in-place: load the existing lot's current data so the operator
  // enriches in place (sees what's already there) and we never clobber a
  // populated field with a blank. onCreate merges + writes back to this lot.
  useEffect(() => {
    const pLotId = typeof params.prefilledLotId === 'string' ? params.prefilledLotId : '';
    // Enrich mode never loads/updates a lot — it returns data to QuickLot.
    if (!pLotId || lotLoadedRef.current || isEnrichMode) return;
    lotLoadedRef.current = true;
    setUpdateLotId(pLotId);
    void (async () => {
      const { data } = await supabase
        .from('lots')
        .select('title, description, msrp_cents, condition, photo_urls')
        .eq('id', pLotId)
        .single();
      const lot = data as {
        title: string | null;
        description: string | null;
        msrp_cents: number | null;
        condition: string | null;
        photo_urls: string[] | null;
      } | null;
      if (!lot) return;
      if (lot.title) setTitle(lot.title);
      if (lot.description) setDescription(lot.description);
      if (lot.msrp_cents && lot.msrp_cents > 0) setMsrpDollars((lot.msrp_cents / 100).toFixed(2));
      if (lot.condition && (ALL_CONDITIONS as readonly string[]).includes(lot.condition)) {
        setCondition(lot.condition as DefaultCondition);
      }
      setExistingPhotos(
        Array.isArray(lot.photo_urls)
          ? lot.photo_urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
          : [],
      );
    })();
  }, [params.prefilledLotId, isEnrichMode]);

  if (role.kind !== 'staff') return null;

  async function onImportFromUrl() {
    const trimmed = importUrl.trim();
    if (!trimmed) {
      Alert.alert('Paste a URL', 'Long-press the box and tap Paste to drop in a product page URL from any major retailer (Amazon, Wayfair, Target, Walmart, Home Depot, and more).');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      Alert.alert('Not a URL', 'The text in the box doesn\'t look like a URL — make sure you copied the full https://… link.');
      return;
    }
    setImportBusy(true);
    setImportStage('reading');
    try {
      // D1-client: two-stage fallback lives in the shared scrapeProductUrl
      // helper. It POSTs WITHOUT the flag first (fast direct read, stage
      // 'reading'); if the server returns ok:false + needs_fallback it
      // retries the SAME url with ?allowAiFallback=1 (stage 'searching').
      // We just react to the stage callback + the final result.
      const result = await scrapeProductUrl(trimmed, (stage) => setImportStage(stage));

      if ('noSession' in result && result.noSession) {
        Alert.alert('Session expired', 'Sign out and back in, then try again.');
        return;
      }
      if (!result.ok) {
        // Final failure (direct with no fallback, or fallback also failed).
        // Never lose the typed url — leave importUrl as-is so the operator
        // can tweak it or fall back to manual entry below.
        Alert.alert(
          "Couldn't read that page",
          `${cleanScrapeError(result.error)}\n\nYou can still search and fill the form manually below.`,
        );
        return;
      }

      // Success — pre-fill the form inline (import-review.tsx was deleted in
      // W2-rest). BUG FIX (D1-client): read primary_image_url + additional_
      // image_urls — the server never returns photo_urls. Matches the Share-
      // Extension / handleShareIntent field mapping above.
      const d = result.data;
      if (d.title) setTitle(d.title);
      if (d.msrp_cents && d.msrp_cents > 0) {
        setMsrpDollars((d.msrp_cents / 100).toFixed(2));
      }
      if (d.primary_image_url) setPhotoUrl(d.primary_image_url);
      // Keep any additional images so onCreate can attach them to photo_urls
      // (primary stays the hero at index 0). The single Photo URL field only
      // shows the hero, but the lot gets the full set.
      setExtraPhotoUrls(Array.isArray(d.additional_image_urls) ? d.additional_image_urls : []);
      const descParts: string[] = [];
      if (d.description) descParts.push(d.description);
      if (d.brand) descParts.push(`Brand: ${d.brand}`);
      if (d.upc) descParts.push(`UPC: ${d.upc}`);
      if (d.asin) descParts.push(`ASIN: ${d.asin}`);
      if (descParts.length) setDescription(descParts.join('\n'));

      const warningsText = result.warnings.length ? ` (${result.warnings.join(', ')})` : '';
      // Surface the AI-fallback source subtly so the operator knows the data
      // came from a web search (less authoritative than a direct page read).
      const sourceNote = result.source === 'ai_fallback' ? ' · found via web search' : '';
      setImportedBanner(
        `Imported from ${result.host}${sourceNote}${warningsText} — review below and tap Create`,
      );
      // Clear the URL field so a return-to-this-screen stays clean.
      setImportUrl('');
    } catch (err) {
      Alert.alert("Couldn't import", (err as Error).message);
    } finally {
      setImportBusy(false);
      setImportStage(null);
    }
  }

  function openExternal(provider: 'google' | 'amazon' | 'ebay') {
    const q = encodeURIComponent(searchQuery.trim());
    if (!q) {
      Alert.alert('Type a search first', 'Enter the product name or SKU you want to look up.');
      return;
    }
    const url =
      provider === 'google'
        ? `https://www.google.com/search?tbm=shop&q=${q}`
        : provider === 'amazon'
          ? `https://www.amazon.com/s?k=${q}`
          : `https://www.ebay.com/sch/?_nkw=${q}`;
    // openBrowserAsync, NOT Linking.openURL — and this is the whole fix for
    // the crash staff have reported for weeks.
    //
    // Linking.openURL hands the URL to Safari as a SEPARATE app, so BinGo goes
    // to the background still holding a camera session and a page of decoded
    // photos. The watchdog caught what happens next, sixteen times on
    // 2026-08-20 alone: "process died while in the background (user had
    // switched away)", most of them on this screen, most with an unsaved draft.
    // iOS reclaims the biggest background process, and that is us.
    //
    // openBrowserAsync presents SFSafariViewController INSIDE our app. Same
    // Safari engine, same logins and cookies, but BinGo stays foreground — so
    // the OS is not choosing between it and whatever else is running. Coming
    // back is a dismissal rather than a cold relaunch, which is also the
    // difference between "back where I was" and "start the item over."
    WebBrowser.openBrowserAsync(url, {
      // Match the app rather than flashing white — these run in a dim
      // warehouse and the screen is read at arm's length.
      toolbarColor: colors.bg,
      controlsColor: colors.primary,
      // Reader mode off, downloads on: the point of the trip is to reach a
      // product image and copy it.
      enableBarCollapsing: true,
    }).catch((err) =>
      // Falling back keeps the trip possible even if the presentation fails;
      // a lost stock photo is worse than a risky background.
      Linking.openURL(url).catch(() =>
        Alert.alert('Could not open browser', String(err)),
      ),
    );
  }

  async function onCreate() {
    if (!title.trim() || role.kind !== 'staff') {
      Alert.alert('Title required', 'Paste or type the item title before creating.');
      return;
    }
    // Staff report 2026-07-10: a pasted Google Shopping PAGE url (or any
    // non-allowlisted host) sailed through this field and was silently
    // dropped by the image-host allowlist downstream — the lot saved with
    // ZERO photos and no error. Reject it loudly here instead.
    if (photoUrl.trim() && !isSafeImageUrl(photoUrl.trim())) {
      Alert.alert(
        'That link won’t work as a photo',
        'Paste a direct IMAGE address from a supported store (long-press the photo → "Copy image address"), or paste the product PAGE link into the Import box above so the photo downloads into our storage.',
      );
      return;
    }
    // Sticker before save: a NEW lot in Pre-stickered mode scans first.
    // Update-in-place and enrich mode change an existing lot: no sticker step.
    let stickerToBind = '';
    if (!updateLotId && !isEnrichMode) {
      const stickerPlan = planStickerBeforeSave({ mode: lottingMode, capturedSticker: capturedStickerRef.current });
      if (stickerPlan.action === 'scan_first') {
        setCaptureSticker(true);
        return;
      }
      stickerToBind = stickerPlan.sticker ?? '';
      capturedStickerRef.current = null;
    }
    setBusy(true);
    try {
      // parseCents strips $, commas + whitespace and rejects negatives, so a
      // pasted "$129" / "1,299.00" no longer reads as NaN.
      const msrpCents = parseCents(msrpDollars);
      if (msrpDollars.trim() && msrpCents === null) {
        throw new Error('Enter a valid MSRP, e.g. 129.00 (or leave blank).');
      }

      // ── QuickLot inline enrichment: return data, create NO lot ───────────
      // Opened from QuickLot (mode=enrich) for an item that isn't a saved lot
      // yet. Hand the scraped/edited fields back to the QuickLot review card
      // via enrichReturnRef and pop — QuickLot merges them and saves ONE lot,
      // so there's no duplicate lot and no sticker prompt here.
      if (isEnrichMode) {
        enrichReturnRef.current = {
          title: title.trim(),
          msrpDollars,
          photoUrl: photoUrl.trim(),
          extraPhotoUrls,
          description: description.trim(),
          condition,
        };
        router.back();
        return;
      }

      // ── Add-Missing-Data: UPDATE the existing lot in place ───────────────
      // Opened from a lot's review card (prefilledLotId) → enrich that lot
      // instead of minting a new one (no duplicate lot, no extra sticker). The
      // stock photo SUPPLEMENTS the operator's inspection photos (box-count /
      // condition shots): stock hero first, then every existing photo. Blank
      // form fields coalesce to the lot's current values so nothing is nulled.
      if (updateLotId) {
        const { data: curData } = await supabase
          .from('lots')
          .select('photo_urls, description, msrp_cents')
          .eq('id', updateLotId)
          .single();
        const cur = curData as {
          photo_urls: string[] | null;
          description: string | null;
          msrp_cents: number | null;
        } | null;
        const curPhotos = Array.isArray(cur?.photo_urls)
          ? cur!.photo_urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
          : existingPhotos;
        const hero = photoUrl.trim();
        const extras = extraPhotoUrls.map((u) => u.trim()).filter(Boolean);
        const mergedPhotos = Array.from(
          new Set([...(hero ? [hero] : []), ...extras, ...curPhotos]),
        );

        const { error: updErr } = await supabase
          .from('lots')
          .update({
            title: title.trim(),
            description: description.trim() || cur?.description || null,
            condition,
            msrp_cents: msrpCents ?? cur?.msrp_cents ?? null,
            photo_urls: mergedPhotos,
          })
          .eq('id', updateLotId);
        if (updErr) throw new Error(updErr.message);

        const kept = curPhotos.length;
        Alert.alert(
          'Lot updated',
          hero
            ? `Saved to this lot. Stock photo added as the main image, ahead of your ${kept} existing photo${kept === 1 ? '' : 's'}.`
            : 'Saved the new data to this lot.',
          [{ text: 'Done', onPress: () => router.back() }],
        );
        return;
      }

      // Mint a fresh lot_code via the existing RPC (used by every other
      // lotting path too). Result is `{operator.code}-NNNNNN`.
      const { data: lotCodeData, error: codeErr } = await supabase.rpc(
        'next_lot_code',
        { p_operator_id: role.operatorId },
      );
      if (codeErr || !lotCodeData) {
        throw new Error(codeErr?.message ?? 'Could not mint lot code');
      }
      const lotCode = lotCodeData as string;

      const startingBidCents = Math.round((session.defaultStartBid ?? 1) * 100);

      // Photo set: hero (the Photo URL field) first, then any additional
      // images the scrape returned, de-duplicated. All are remote retailer
      // URLs (the is_safe_image_url DB CHECK + filterSafeImageUrls drop any
      // off-allowlist host) — there are no file:// URIs on this paste-URL
      // path, so no upload step is needed here.
      const hero = photoUrl.trim();
      const photoUrls = Array.from(
        new Set([...(hero ? [hero] : []), ...extraPhotoUrls.map((u) => u.trim()).filter(Boolean)]),
      );

      const { data: inserted, error: insErr } = await supabase
        .from('lots')
        .insert({
          operator_id: role.operatorId,
          lot_code: lotCode,
          title: title.trim(),
          description: description.trim() || null,
          condition,
          msrp_cents: msrpCents,
          starting_bid_cents: startingBidCents,
          photo_urls: photoUrls,
          source: activeLotSource(session) || null,
          // Mig 0428: the shift's load. This screen inserts directly (no
          // create_draft_lot), so it has to carry the load itself. Null when
          // no load is picked — same as before.
          load_id: getActiveLottingLoadId(),
          status: 'pending_intake',
        })
        .select('id, lot_code')
        .single();
      if (insErr || !inserted) {
        // Same plain-cause copy and server-side record as the other lotting
        // screens; this path inserts directly, so the reason is the raw error.
        const failure = {
          code: 'insert_failed' as const,
          reason: insErr?.message ?? 'insert returned no row',
        };
        reportNonFatal(lotCreateFailureReport(failure, { screen: '/lotting/web', lottingMode }));
        throw new Error(lotCreateUserMessage(failure).message);
      }

      const ins = inserted as { id: string; lot_code: string };
      pushRecentLot({
        lotCode: ins.lot_code,
        lotId: ins.id,
        externalCode: '', // no scanned code in the web-lookup flow
        title: title.trim(),
        source: activeLotSource(session) || undefined,
      });

      if (lottingMode !== 'generate') {
        // The lot row already carries an auto-generated qr_token from
        // the create_draft_lot RPC / direct insert default. Now we
        // capture whatever sticker the operator scans — PreStickeredScanner
        // routes a UUID to claim_prestickered_qr (rotates lots.qr_token) and
        // any other code to claim_sticker_code (lots.sticker_code). We
        // reset the form once the operator either assigns a sticker
        // or explicitly skips.
        if (stickerToBind) {
          // NOT awaited (2026-10-08): `busy` used to wait on this request
          // with no limit. Time-boxed; a network failure is kept on the phone
          // and retried; a refusal reopens the scanner for this lot.
          void bindStickerAfterSave({ lotId: ins.id, lotCode: ins.lot_code, sticker: stickerToBind }).then(
            (outcome) => {
              if (outcome.kind !== 'refused') return;
              Alert.alert(
                'Sticker not bound',
                `${stickerRefusalCopy(outcome.reason)}\n\nLot ${ins.lot_code} was created, but the sticker is NOT attached yet. Scan a sticker to finish (or open ${ins.lot_code} in Inventory).`,
              );
              setPendingSticker({ lotId: ins.id, lotCode: ins.lot_code });
            },
          );
          finishCreated(ins.lot_code, 'attaching');
          return;
        }
        setPendingSticker({ lotId: ins.id, lotCode: ins.lot_code });
        return;
      }

      Alert.alert('Lot created', `${ins.lot_code} · ${title.trim()}`, [
        {
          text: 'Create another',
          onPress: () => {
            setSearchQuery('');
            setTitle('');
            setMsrpDollars('');
            setPhotoUrl('');
            setExtraPhotoUrls([]);
            setDescription('');
          },
        },
        {
          text: 'Done',
          onPress: () => router.back(),
        },
      ]);
    } catch (err) {
      Alert.alert('Could not create lot', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Called when the pre-stickered scanner closes — either after a
  // successful claim (assigned=true) or operator cancel (assigned=false).
  // In both cases the lot is already saved; the only difference is
  // whether its qr_token got rotated to the scanned sticker. We reset
  // the form so the operator can lot the next item.
  function onScannerClose(assigned: boolean) {
    if (!pendingSticker) return;
    const lotCode = pendingSticker.lotCode;
    setPendingSticker(null);
    finishCreated(lotCode, assigned);
  }
  function finishCreated(lotCode: string, assigned: boolean | 'attaching') {
    Alert.alert(
      assigned === true ? 'Sticker assigned' : 'Lot created',
      assigned === 'attaching'
        ? `${lotCode} — sticker scanned, attaching now.`
        : assigned
          ? `${lotCode} — sticker scanned and bound to the lot.`
          : `${lotCode} — saved with auto-generated QR. Print the label from Inventory → ${lotCode} when ready.`,
      [
        {
          text: 'Create another',
          onPress: () => {
            setSearchQuery('');
            setTitle('');
            setMsrpDollars('');
            setPhotoUrl('');
            setExtraPhotoUrls([]);
            setDescription('');
          },
        },
        {
          text: 'Done',
          onPress: () => router.back(),
        },
      ],
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <LottingModeToggle disabled={busy || importBusy} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 80 }}>
        <View>
          <Text style={s.heading}>{isEnrichMode || updateLotId ? 'Add Missing Data' : 'Web Lookup'}</Text>
          <Text style={s.subheading}>
            For items that AI Photo and Quick Lot can&apos;t identify. Two ways:
            paste a product URL from any retailer product page for a one-tap
            import, or fall back to search-and-paste below.
          </Text>
        </View>

        {/* ── One-click URL import (added 2026-05-21) ────────────────────────── */}
        <View style={[s.card, { backgroundColor: 'rgba(34,197,94,0.06)', borderColor: 'rgba(34,197,94,0.35)' }]}>
          <Text style={[s.label, { color: '#22c55e' }]}>⚡ One-click: paste a URL</Text>
          <TextInput
            value={importUrl}
            onChangeText={setImportUrl}
            placeholder="https://… product page URL (long-press → Paste)"
            placeholderTextColor={colors.textMuted}
            style={s.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!importBusy}
          />
          <Pressable
            onPress={onImportFromUrl}
            disabled={importBusy || !importUrl.trim()}
            style={[
              s.providerBtn,
              {
                backgroundColor: importUrl.trim() && !importBusy ? '#22c55e' : colors.surface,
                borderColor: importUrl.trim() && !importBusy ? '#22c55e' : colors.border,
                paddingVertical: 12,
              },
            ]}
          >
            {importBusy ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text
                style={[
                  s.providerText,
                  { color: importUrl.trim() ? '#000' : colors.textMuted, fontWeight: '900' },
                ]}
              >
                Import
              </Text>
            )}
          </Pressable>
          {/* D1-client: two-stage progress. 'reading' = fast direct attempt;
              'searching' = the site blocked us and we're using web search. */}
          {importStage ? (
            <Text style={[s.hint, { color: '#22c55e', fontWeight: '700' }]}>
              {importStage === 'reading'
                ? 'Reading the page…'
                : 'Site blocks direct reads — searching the web…'}
            </Text>
          ) : (
            <Text style={s.hint}>
              Copy the product URL from any retailer&apos;s page in Safari (tap the share
              button → Copy), come back here, long-press the box, tap Paste, then Import.
              We&apos;ll fetch the title, price, and photos automatically and pre-fill the
              form below to review.
            </Text>
          )}
        </View>

        {/* 1. Search */}
        <View style={s.card}>
          <Text style={s.label}>1. Or search the web manually</Text>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="e.g. DeWalt DCD771C2 20V drill"
            placeholderTextColor={colors.textMuted}
            style={s.input}
            autoCorrect={false}
          />
          <View style={s.providerRow}>
            <Pressable onPress={() => openExternal('google')} style={s.providerBtn}>
              <Text style={s.providerText}>🛍 Google Shopping</Text>
            </Pressable>
            <Pressable onPress={() => openExternal('amazon')} style={s.providerBtn}>
              <Text style={s.providerText}>📦 Amazon</Text>
            </Pressable>
            <Pressable onPress={() => openExternal('ebay')} style={s.providerBtn}>
              <Text style={s.providerText}>🏷 eBay</Text>
            </Pressable>
          </View>
          <Text style={s.hint}>
            Opens a browser. From the results page: copy the item title, note the MSRP/list
            price, and long-press a product image → &quot;Copy image link&quot; to grab the
            photo URL.
          </Text>
        </View>

        {/* W2-rest: imported-data banner — shown after one-click scrape fills form */}
        {importedBanner ? (
          <Pressable
            onPress={() => setImportedBanner(null)}
            style={{
              backgroundColor: 'rgba(34,197,94,0.12)',
              borderColor: 'rgba(34,197,94,0.4)',
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            }}
          >
            <Text style={{ color: '#22c55e', fontSize: 13, fontWeight: '600' }}>
              {importedBanner}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
              Tap to dismiss
            </Text>
          </Pressable>
        ) : null}

        {/* 2. Paste the data back */}
        <View style={s.card}>
          <Text style={s.label}>2. Paste what you found</Text>

          <Text style={s.fieldLabel}>Title *</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. DeWalt 20V MAX Cordless Drill / Driver Kit"
            placeholderTextColor={colors.textMuted}
            style={s.input}
            multiline
            autoCorrect
          />

          <Text style={s.fieldLabel}>MSRP / Retail price (USD)</Text>
          <TextInput
            value={msrpDollars}
            onChangeText={setMsrpDollars}
            placeholder="129.00"
            placeholderTextColor={colors.textMuted}
            style={s.input}
            keyboardType="decimal-pad"
          />

          <Text style={s.fieldLabel}>Photo URL (paste)</Text>
          <TextInput
            value={photoUrl}
            onChangeText={setPhotoUrl}
            placeholder="https://… (long-press image → Copy image link)"
            placeholderTextColor={colors.textMuted}
            style={s.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={s.fieldLabel}>Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Notes, dimensions, what&apos;s included, etc."
            placeholderTextColor={colors.textMuted}
            style={[s.input, { minHeight: 80 }]}
            multiline
          />
        </View>

        {/* 3. Condition */}
        <View style={s.card}>
          <Text style={s.label}>3. Condition</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {ALL_CONDITIONS.map((c) => {
              const active = condition === c;
              const col = CONDITION_COLORS[c];
              return (
                <Pressable
                  key={c}
                  onPress={() => setCondition(c)}
                  style={[
                    s.condChip,
                    active && {
                      backgroundColor: `${col}22`,
                      borderColor: `${col}66`,
                    },
                  ]}
                >
                  <Text style={[s.condChipText, active && { color: col }]}>
                    {CONDITION_LABELS[c]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          onPress={onCreate}
          disabled={busy || !title.trim()}
          style={[
            s.createBtn,
            (!title.trim() || busy) && { opacity: 0.4 },
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={s.createBtnText}>{isEnrichMode ? 'Use this data' : updateLotId ? 'Save to this lot' : 'Create lot'}</Text>
          )}
        </Pressable>

        <Text style={s.footnote}>
          {isEnrichMode
            ? "Adds this data to the item you're lotting — no separate lot is created here. Tap Save Lot back on the scan screen to finish as one lot."
            : updateLotId
            ? 'Updates this existing lot in place — no new lot or sticker is created. Your inspection photos are kept; the stock photo is added as the main image.'
            : 'Creates a lot in pending_intake status with a fresh lot_code. Pick it up at the staging area, then scan it into a bin via the picker app to move it to Inventory.'}
        </Text>
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
              setTimeout(() => void onCreate(), 0);
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
          onAssigned={() => onScannerClose(true)}
          onCancel={() => onScannerClose(false)}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  heading: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  subheading: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  card: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    gap: 10,
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 6,
    marginBottom: 4,
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 14,
  },
  providerRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  providerBtn: {
    flex: 1,
    minWidth: 100,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  providerText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
  hint: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  condChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  condChipText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  createBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  createBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  footnote: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 8,
  },
});
