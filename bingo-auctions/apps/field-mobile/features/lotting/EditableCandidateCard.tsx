// EditableCandidateCard — fully editable candidate review card.
//
// Every field is a controlled TextInput (or chip selector).  The caller
// owns the state via `value` / `onChange`.  The Save button lives
// outside this component (in the parent screen), so this is pure
// presentation + editing UI.
//
// Fields:
//   title (required TextInput)
//   brand  TextInput
//   model  TextInput
//   upc    TextInput, numeric keyboard, normalizeUpc on blur
//   category   chip row (CATEGORIES const)
//   condition  4-chip row, pre-selected from session default
//   msrp       TextInput, dollar value, parseCents on blur
//   startBid   TextInput, dollar value, parseCents on blur
//   description  multiline TextInput
//   stockPhotos  thumbnails with retake/clear buttons
//
// Thumbnail rendering:
//   - expo-image <Image> with explicit width+height so React Native
//     doesn't collapse the view to 0×0 when no intrinsic size is known.
//   - contentFit="cover" + cachePolicy="memory-disk" for fast display.
//   - placeholder prop (blurhash or tint color) so the slot is visible
//     while the image loads.
//   - isSafeImageUrl guard: URLs that fail the allowlist are silently
//     dropped by the domain layer — we skip empty strings to avoid
//     broken image views.
//     TODO(thumbnail-bug): If images still look wrong, enable console
//     logging on the stockPhotos array before render to verify that
//     isSafeImageUrl in domain-lotting/lookup/merge is not filtering
//     the URLs you expect. Check ALLOWED_IMAGE_HOSTS in normalize/images
//     if a CDN domain is missing.

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  Keyboard,
  InputAccessoryView,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  parseCents,
  normalizeUpc,
  CATEGORIES,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { colors, type } from '@auction-platform/design-system';
import { PhotoViewer, usePhotoViewer } from './PhotoViewer';
import { CameraCaptureSheet } from '@/features/camera/CameraCaptureSheet';
import {
  ALL_CONDITIONS,
  CONDITION_LABELS,
  CONDITION_COLORS,
  type DefaultCondition,
} from './SessionContext';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EditableCandidate = {
  title: string;
  brand: string;
  model: string;
  upc: string;
  category: string;
  condition: DefaultCondition | '';
  msrpDollars: string;       // raw dollar string while editing, e.g. "29.99"
  startBidDollars: string;   // raw dollar string while editing, e.g. "1.00"
  /** W11 / mig 0140: optional reserve floor. Empty string = no reserve.
   *  Not enforced by bidding RPCs yet — stored to lots.reserve_cents. */
  reserveDollars: string;
  description: string;
  stockPhotos: string[];
};

type Props = {
  value: EditableCandidate;
  onChange: (patch: Partial<EditableCandidate>) => void;
  /** Called when the user taps the photo row to retake / change photos. */
  onClearPhoto?: (index: number) => void;
  /** When set, the embedded "web lookup for missing data" opens in
   *  update-in-place mode for THIS lot (passes prefilledLotId) instead of
   *  creating a new lot. Only worklist/[id] (an existing lot) sets this; the
   *  new-lotting sites (scan / quick / photo) leave it undefined → create. */
  lotId?: string;
  /** When set (and lotId is NOT set), the "web lookup for missing data" button
   *  opens in ENRICH mode (mode=enrich): scraped data returns to the in-review
   *  candidate instead of creating a lot. QuickLot passes this so an unsaved
   *  item is enriched in place, not duplicated. Called just before navigation
   *  (e.g. to pause QuickLot's auto-create timer). */
  onWebLookupEnrich?: () => void;
  /** When true, the optional Reserve price field is not rendered. Used by
   *  the QuickLot review variant where reserve isn't part of the rapid
   *  intake flow. Default false — all other call sites (scan / photo /
   *  worklist) render the Reserve field unchanged. */
  hideReserve?: boolean;
};

// UI-1: shared iOS keyboard-accessory id. The decimal-pad fields (MSRP /
// Starting bid / Reserve) already show iOS's built-in Done accessory; the
// default-keyboard fields (UPC, multiline Description) don't. We attach ONE
// InputAccessoryView with a Done button to those two via inputAccessoryViewID
// so every field dismisses the keyboard consistently. iOS-only — Android
// ignores inputAccessoryViewID and the view isn't rendered there.
const DONE_ACCESSORY_ID = 'editable-candidate-done';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Round-trip dollars → cents → plain decimal string.
 *  centsToDollars returns "$1,234.56" which is valid for parseCents but
 *  jarring in a text input — we emit a plain "1234.56" for editing UX. */
function normalizeDollarInput(raw: string): string {
  const cents = parseCents(raw);
  if (cents === null || cents < 0) return raw; // preserve invalid for user
  return (cents / 100).toFixed(2);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EditableCandidateCard({ value, onChange, onClearPhoto, hideReserve = false, lotId, onWebLookupEnrich }: Props) {
  // Safe stock photos — skip empty strings that domain filtering produced.
  // This is the canonical working list: we both render from it AND write it
  // straight back via onChange on add / remove / reorder, so the parent's
  // stockPhotos stays free of empties and index math always lines up.
  const safePhotos = value.stockPhotos.filter((url) => url.trim().length > 0);
  // Photo viewer for tap-to-zoom on the thumb strip below. Local state
  // so each card instance gets its own viewer — fine because at most one
  // EditableCandidateCard is mounted at a time in scan.tsx / quick.tsx.
  const photoViewer = usePhotoViewer();
  const router = useRouter();

  // D4: "+ Add photo" → shared CameraCaptureSheet (multi-photo). The sheet is
  // seeded with the current photos so the operator sees what's already there
  // and the returned list becomes the card's photos (hero = index 0). Newly
  // captured entries are file:// URIs — the SAVE path (scan.tsx / quick.tsx /
  // worklist) uploads them via uploadPendingPhotos before persisting, so no
  // file:// ever reaches photo_urls.
  const [cameraOpen, setCameraOpen] = useState(false);

  // D4: move a photo to the front (hero). Used by the long-press / "★ hero"
  // affordance so the operator picks which shot lands as photo_urls[0].
  const makeHero = (index: number) => {
    if (index <= 0 || index >= safePhotos.length) return;
    const next = [...safePhotos];
    const [picked] = next.splice(index, 1);
    if (picked === undefined) return;
    next.unshift(picked);
    onChange({ stockPhotos: next });
  };

  // D4: remove a photo at a rendered (safePhotos) index. Prefer the parent's
  // onClearPhoto when supplied — every current consumer implements it as a
  // pure index-filter on stockPhotos, and the card now keeps stockPhotos free
  // of empty strings (add/reorder write clean arrays), so the safePhotos index
  // aligns with the parent's stockPhotos index. When no handler is provided we
  // write the trimmed list directly. We never do BOTH (that would remove from
  // two different base arrays).
  const removeAt = (index: number) => {
    if (onClearPhoto) {
      onClearPhoto(index);
    } else {
      onChange({ stockPhotos: safePhotos.filter((_, i) => i !== index) });
    }
  };

  // D4: append newly captured/confirmed photos. The CameraCaptureSheet returns
  // the FULL list it was seeded with (existing + new), so we just replace —
  // de-duped, preserving order, hero stays index 0.
  const onCameraConfirm = (uris: string[]) => {
    setCameraOpen(false);
    const next = Array.from(new Set(uris.map((u) => u.trim()).filter(Boolean)));
    onChange({ stockPhotos: next });
  };

  return (
    <View style={s.card}>
      {/* ── Photos row (D4: multi-photo + reorder + add) ────────────────── */}
      <View style={{ marginBottom: 12 }}>
        <Text style={s.fieldLabel}>Photos</Text>
        {/* PHOTO-3: when the catalog returns several stock photos they all land
            here. Tell the operator how to curate them (drop the bad ones, pick
            the hero). Hidden when there are no photos yet. */}
        {safePhotos.length > 0 && (
          <Text style={s.photoHint}>
            Tap × to drop · long-press a photo to make it the hero
          </Text>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {/* D4: no longer capped at 4 — the operator can keep as many shots
              as they capture. photo_urls[0] = hero. Long-press a non-hero
              thumb (or tap its ★ badge) to promote it to hero. */}
          {safePhotos.map((url, i) => (
            <Pressable
              key={`${url}-${i}`}
              onPress={() => photoViewer.open(safePhotos, i)}
              onLongPress={() => makeHero(i)}
              accessibilityHint={
                i === 0
                  ? 'Hero photo. Long-press another photo to make it the hero.'
                  : 'Tap to view. Long-press to make this the hero photo.'
              }
              style={s.photoThumb}
            >
              {/* expo-image requires explicit width+height or a flex
                  style on the parent to avoid 0×0 collapse. Both are
                  set here: the outer View has fixed dimensions and
                  the Image fills it via style={{ flex: 1 }}. */}
              <Image
                source={{ uri: url }}
                style={{ flex: 1, borderRadius: 8 }}
                contentFit="cover"
                cachePolicy="memory-disk"
                // blurhash-style single-color placeholder: a 1x1 pixel
                // data URI for the surface color so there's no blank flash.
                // expo-image placeholder accepts a blurhash string or URI.
                placeholder="L00000fQfQfQ~qfQfQfQfQfQfQ"
                transition={150}
              />
              {/* PHOTO-3: STOCK vs YOURS source badge (top-left) so staff can
                  tell catalog stock photos from shots they captured while
                  curating multiple options. At review time captured photos are
                  file://|content:// (uploaded by the SAVE path); anything else
                  is a catalog/stock URL. */}
              <View
                style={[
                  s.kindBadge,
                  /^(file|content):\/\//i.test(url) ? s.kindBadgeYours : s.kindBadgeStock,
                ]}
                pointerEvents="none"
              >
                <Text style={s.kindBadgeText}>
                  {/^(file|content):\/\//i.test(url) ? 'YOURS' : 'STOCK'}
                </Text>
              </View>
              {/* Hero badge on index 0; a "make hero" (★) affordance on the
                  rest so reorder works without relying on long-press alone. */}
              {i === 0 ? (
                <View style={s.heroBadge} pointerEvents="none">
                  <Text style={s.heroBadgeText}>HERO</Text>
                </View>
              ) : (
                <Pressable
                  onPress={() => makeHero(i)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Make photo ${i + 1} the hero`}
                  accessibilityHint="Moves this photo to the front as the main listing image"
                  style={s.makeHeroBtn}
                >
                  <Text style={s.makeHeroBtnText}>★ hero</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => removeAt(i)}
                // hitSlop 12 turns the 20×20 badge into a 44×44 touch
                // target without crowding the photo thumb (UX-P1-2,
                // WCAG 2.2 AA minimum).
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${i + 1}`}
                accessibilityHint="Removes this photo from the lot candidate"
                style={s.photoClearBtn}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                  ×
                </Text>
              </Pressable>
            </Pressable>
          ))}

          {/* D4: "+ Add photo" tile — opens the shared CameraCaptureSheet
              (multi-photo) seeded with the current photos. Always present so
              the operator can add real condition shots to a stock-only or
              empty candidate. */}
          <Pressable
            onPress={() => setCameraOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Add photo"
            accessibilityHint="Opens the camera to capture one or more photos for this lot"
            style={[s.photoThumb, s.addPhotoTile]}
          >
            <Text style={s.addPhotoTilePlus}>+</Text>
            <Text style={s.addPhotoTileLabel}>Add photo</Text>
          </Pressable>
        </ScrollView>
      </View>

      {/* D4: shared capture sheet. Seeds initialUris with the current photos
          so the operator sees what's already attached; onConfirm returns the
          FULL list (existing + new), which becomes the card's photos. Newly
          captured file:// URIs are uploaded by the SAVE path
          (uploadPendingPhotos) before persisting. */}
      <CameraCaptureSheet
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onConfirm={onCameraConfirm}
        initialUris={safePhotos}
        title="Add lot photos"
      />

      {/* ── Title ──────────────────────────────────────────────────────── */}
      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>
          Title <Text style={{ color: colors.danger }}>*</Text>
        </Text>
        <TextInput
          value={value.title}
          onChangeText={(t) => onChange({ title: t })}
          placeholder="Item title"
          placeholderTextColor={colors.textMuted}
          style={[s.textInput, s.titleInput]}
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit
        />
      </View>

      {/* ── Description (C3 #7: moved directly under Title) ──────────────── */}
      {/* Sits right beneath Title so the operator captures condition notes
          while the item is in hand, before scrolling through the pricing /
          category fields. */}
      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>Description</Text>
        <TextInput
          value={value.description}
          onChangeText={(t) => onChange({ description: t })}
          placeholder="Optional condition notes, missing parts, damage…"
          placeholderTextColor={colors.textMuted}
          style={[s.textInput, s.descriptionInput]}
          multiline
          textAlignVertical="top"
          blurOnSubmit
          // UI-1: multiline can't use returnKeyType to dismiss (Return inserts
          // a newline), so the shared iOS Done accessory is the dismiss path.
          inputAccessoryViewID={Platform.OS === 'ios' ? DONE_ACCESSORY_ID : undefined}
        />
      </View>

      {/* ── Brand + Model row ───────────────────────────────────────────── */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={[s.fieldGroup, { flex: 1 }]}>
          <Text style={s.fieldLabel}>Brand</Text>
          <TextInput
            value={value.brand}
            onChangeText={(t) => onChange({ brand: t })}
            placeholder="Brand"
            placeholderTextColor={colors.textMuted}
            style={s.textInput}
            autoCorrect={false}
            returnKeyType="done"
            blurOnSubmit
          />
        </View>
        <View style={[s.fieldGroup, { flex: 1 }]}>
          <Text style={s.fieldLabel}>Model</Text>
          <TextInput
            value={value.model}
            onChangeText={(t) => onChange({ model: t })}
            placeholder="Model #"
            placeholderTextColor={colors.textMuted}
            style={[s.textInput, { fontFamily: 'monospace' }]}
            autoCorrect={false}
            autoCapitalize="characters"
            returnKeyType="done"
            blurOnSubmit
          />
        </View>
      </View>

      {/* ── UPC ────────────────────────────────────────────────────────── */}
      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>UPC / Barcode</Text>
        <TextInput
          value={value.upc}
          onChangeText={(t) => onChange({ upc: t })}
          placeholder="00012345678901"
          placeholderTextColor={colors.textMuted}
          style={[s.textInput, { fontFamily: 'monospace', letterSpacing: 1 }]}
          keyboardType="default"
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit
          // UI-1: also surface the shared iOS Done accessory so this single-
          // line field matches the decimal-pad fields' built-in Done bar.
          inputAccessoryViewID={Platform.OS === 'ios' ? DONE_ACCESSORY_ID : undefined}
          onBlur={() => {
            // normalizeUpc from the lookup/cache barrel (non-strict variant)
            // sanitizes dashes and spaces but doesn't reject valid lengths.
            const cleaned = normalizeUpc(value.upc);
            if (cleaned !== value.upc) onChange({ upc: cleaned });
          }}
        />
      </View>

      {/* ── Category chips ──────────────────────────────────────────────── */}
      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>Category</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingRight: 4 }}
        >
          {CATEGORIES.map((cat) => {
            const active = value.category === cat;
            return (
              <Pressable
                key={cat}
                onPress={() => onChange({ category: active ? '' : cat })}
                style={[s.chip, active && s.chipActive]}
              >
                <Text style={[s.chipText, active && s.chipTextActive]}>
                  {cat}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* ── Condition chips ─────────────────────────────────────────────── */}
      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>Condition</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {ALL_CONDITIONS.map((cond) => {
            const active = value.condition === cond;
            const col = CONDITION_COLORS[cond];
            return (
              <Pressable
                key={cond}
                onPress={() => onChange({ condition: active ? '' : cond })}
                style={[
                  s.conditionChip,
                  active && {
                    backgroundColor: `${col}22`,
                    borderColor: `${col}66`,
                  },
                ]}
              >
                <Text
                  style={[
                    s.conditionChipText,
                    active && { color: col },
                  ]}
                >
                  {CONDITION_LABELS[cond]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ── MSRP + Starting bid row ─────────────────────────────────────── */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={[s.fieldGroup, { flex: 1 }]}>
          <Text style={s.fieldLabel}>MSRP ($)</Text>
          <TextInput
            value={value.msrpDollars}
            onChangeText={(t) => onChange({ msrpDollars: t })}
            placeholder="0.00"
            placeholderTextColor={colors.textMuted}
            style={[s.textInput, { textAlign: 'right' }]}
            keyboardType="decimal-pad"
            onBlur={() => {
              const norm = normalizeDollarInput(value.msrpDollars);
              if (norm !== value.msrpDollars) onChange({ msrpDollars: norm });
            }}
          />
        </View>
        <View style={[s.fieldGroup, { flex: 1 }]}>
          <Text style={s.fieldLabel}>Starting Bid ($)</Text>
          <TextInput
            value={value.startBidDollars}
            onChangeText={(t) => onChange({ startBidDollars: t })}
            placeholder="1.00"
            placeholderTextColor={colors.textMuted}
            style={[s.textInput, { textAlign: 'right' }]}
            keyboardType="decimal-pad"
            onBlur={() => {
              const norm = normalizeDollarInput(value.startBidDollars);
              if (norm !== value.startBidDollars) onChange({ startBidDollars: norm });
            }}
          />
        </View>
      </View>

      {/* ── Reserve price (optional) — W11 / mig 0140 ──────────────────── */}
      {/* Stored to lots.reserve_cents. Not enforced by bidding RPCs yet.
          Displayed as a single-field row so it doesn't crowd the bid row.
          Hidden in the QuickLot review variant (hideReserve) where reserve
          isn't part of the rapid intake flow. */}
      {!hideReserve && (
        <View style={s.fieldGroup}>
          <Text style={s.fieldLabel}>Reserve price (optional)</Text>
          <TextInput
            value={value.reserveDollars}
            onChangeText={(t) => onChange({ reserveDollars: t })}
            placeholder="Future reserve floor. Not enforced by bidding yet."
            placeholderTextColor={colors.textMuted}
            style={[s.textInput, { textAlign: 'right' }]}
            keyboardType="decimal-pad"
            onBlur={() => {
              if (!value.reserveDollars.trim()) return;
              const norm = normalizeDollarInput(value.reserveDollars);
              if (norm !== value.reserveDollars) onChange({ reserveDollars: norm });
            }}
          />
        </View>
      )}

      {/* ── Web lookup escape hatch — W2-rest ───────────────────────────── */}
      {/* Embedded here so operators don't need to leave the review card to
          look up pricing or title data. Navigates to /lotting/web with
          whatever title/UPC context the card has pre-filled. */}
      <Pressable
        onPress={() => {
          // Three modes:
          //  - lotId set (worklist / existing lot)   → update THAT lot in place
          //  - onWebLookupEnrich set (QuickLot)       → enrich the in-review
          //    candidate and return; NO lot is created (avoids the duplicate-
          //    lot / extra-sticker confusion on an unsaved item)
          //  - neither (legacy)                       → create a new lot
          if (onWebLookupEnrich && !lotId) onWebLookupEnrich();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (router as any).push({
            pathname: '/lotting/web',
            params: {
              prefilledTitle: value.title,
              prefilledCode: value.upc,
              ...(lotId
                ? { prefilledLotId: lotId }
                : onWebLookupEnrich
                  ? { mode: 'enrich' }
                  : {}),
            },
          });
        }}
        style={s.webLookupBtn}
      >
        <Text style={s.webLookupBtnText}>🔍 Try web lookup for missing data</Text>
      </Pressable>

      <PhotoViewer state={photoViewer.state} onClose={photoViewer.close} />

      {/* UI-1: one shared iOS keyboard accessory with a Done button. Referenced
          by the UPC + Description inputs via inputAccessoryViewID so they get
          the same Done dismiss the decimal-pad fields have natively. iOS-only:
          InputAccessoryView is a no-op shell on Android, so we don't render it
          there. */}
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={DONE_ACCESSORY_ID}>
          <View style={s.keyboardAccessory}>
            <Pressable
              onPress={() => Keyboard.dismiss()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dismiss keyboard"
              style={s.keyboardAccessoryBtn}
            >
              <Text style={s.keyboardAccessoryText}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      )}
    </View>
  );
}

// ── Helpers for callers ───────────────────────────────────────────────────────

/**
 * Build an EditableCandidate pre-filled from a LotCandidate + session defaults.
 * Call this when transitioning from scan result → review card.
 */
export function candidateToEditable(
  candidate: {
    title?: string;
    brand?: string;
    model?: string;
    upc?: string;
    category?: string;
    condition?: string;
    msrp?: number | null;
    startBid?: number | null;
    /** W11: optional reserve price in dollars (from existing lot row). */
    reserveDollars?: string;
    description?: string;
    stockPhotos?: string[];
  },
  defaults: { defaultCondition: DefaultCondition; defaultStartBid: number },
): EditableCandidate {
  // Map the candidate's condition string to our 4-value platform enum.
  // Used as a fallback ONLY when the operator hasn't set a session default.
  // Previously this overrode the session default whenever AI returned ANY
  // recognizable condition string — user reported (2026-05-13) that the
  // default they chose ("appears_new" for a fresh return-truck pallet)
  // kept getting clobbered by AI's "good" inference. The operator's own
  // session preference is now authoritative; the AI's condition is only
  // used when no default is set.
  const mappedCondition = ((): DefaultCondition | '' => {
    const c = (candidate.condition ?? '').toLowerCase();
    if (c.includes('new') || c.includes('sealed') || c.includes('appears')) return 'appears_new';
    if (c.includes('open') || c.includes('box')) return 'open_box';
    if (c.includes('as') && c.includes('is') || c.includes('damage') || c.includes('parts')) return 'as_is';
    if (c.includes('good') || c.includes('fair') || c.includes('used')) return 'good';
    return '';
  })();

  return {
    title: candidate.title ?? '',
    brand: candidate.brand ?? '',
    model: candidate.model ?? '',
    upc: candidate.upc ?? '',
    category: candidate.category ?? '',
    condition: defaults.defaultCondition || mappedCondition,
    // Use plain decimal strings for TextInput — parseCents accepts them on save.
    msrpDollars: candidate.msrp != null ? (candidate.msrp).toFixed(2) : '',
    // Starting bid policy (W2, 2026-05-26): always default to
    // `defaultStartBid` (typically $1). The prior useAiPricer toggle
    // is gone per plan D4 — "no AI pricing on starting bid." The
    // operator can still type a different value in the review screen.
    // For the worklist edit-existing-lot path (which DOES need to keep
    // whatever the row already has), the caller overrides
    // `ed.startBidDollars` after this helper returns.
    startBidDollars: (defaults.defaultStartBid).toFixed(2),
    reserveDollars: candidate.reserveDollars ?? '',
    description: candidate.description ?? '',
    stockPhotos: (candidate.stockPhotos ?? []).filter((u) => u.trim().length > 0),
  };
}

/**
 * Convert an EditableCandidate back to a LotCandidate for useLotCreation.
 * Normalizes dollar strings to numbers and casts to the correct union types.
 */
/** Extended LotCandidate with optional W11 reserve price. */
export type LotCandidateWithReserve = LotCandidate & {
  /** W11 / mig 0140: reserve_cents to write to lots.reserve_cents.
   *  null = no reserve. Not yet enforced by bidding RPCs. */
  reserveCents: number | null;
};

export function editableToCandidate(editable: EditableCandidate): LotCandidateWithReserve {
  const msrpCents = parseCents(editable.msrpDollars);
  const startCents = parseCents(editable.startBidDollars);
  // W11: parse optional reserve price. Empty or invalid string = no reserve.
  const reserveParsed = editable.reserveDollars.trim()
    ? parseCents(editable.reserveDollars)
    : null;
  const reserveCents = reserveParsed != null && reserveParsed >= 1 ? reserveParsed : null;
  return {
    title: editable.title.trim(),
    fullTitle: editable.title.trim(),
    brand: editable.brand.trim(),
    model: editable.model.trim(),
    upc: normalizeUpc(editable.upc),
    // Cast category — CATEGORIES is readonly string[], 'Other' is always valid.
    category: (editable.category || 'Other') as LotCandidate['category'],
    subcategory: '',          // Operator-edited card doesn't yet expose subcategory UI
    packagingMsrp: null,      // Only the AI vision step reads MSRP from packaging
    // condition on LotCandidate is Condition | ''. The DefaultCondition values
    // ('appears_new'|'open_box'|'good'|'as_is') are the platform enum; they
    // don't match the LotTR Condition enum ('New/Sealed' etc). persistence.ts
    // runs normalizeCondition() which maps both sets. Cast via string is safe.
    condition: editable.condition as LotCandidate['condition'],
    description: editable.description.trim(),
    searchQuery: '',
    confidence: 'low',
    notes: '',
    prices: [],
    stockPhotos: editable.stockPhotos.filter((u) => u.trim().length > 0),
    msrp: msrpCents != null ? msrpCents / 100 : null,
    avg: null,
    startBid: startCents != null ? startCents / 100 : 1,
    specs: '',
    // W11: reserve price. Persisted by callers that use LotCandidateWithReserve.
    // TODO(W11-enforcement): wire into create_draft_lot RPC when p_reserve_cents
    // parameter is added. For now callers do a follow-up UPDATE after creation.
    reserveCents,
  };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 14,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    ...type.label,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.6,
  },
  textInput: {
    padding: 12,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
  },
  titleInput: {
    fontSize: 17,
    fontWeight: '700',
    minHeight: 52,
  },
  descriptionInput: {
    minHeight: 80,
    fontSize: 13,
    lineHeight: 20,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: `${colors.primary}66`,
    backgroundColor: colors.primaryDim,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.primary,
  },
  conditionChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  conditionChipText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    position: 'relative',
  },
  photoClearBtn: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // PHOTO-3: STOCK / YOURS source badge (top-left of each thumb).
  kindBadge: {
    position: 'absolute',
    top: 3,
    left: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  kindBadgeStock: {
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  kindBadgeYours: {
    backgroundColor: 'rgba(21,128,61,0.9)',
  },
  kindBadgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  photoHint: {
    color: colors.textMuted,
    fontSize: 11,
    marginBottom: 6,
  },
  // D4: hero marker on photo_urls[0].
  heroBadge: {
    position: 'absolute',
    bottom: 3,
    left: 3,
    backgroundColor: colors.primary,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  heroBadgeText: {
    color: '#000',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  // D4: "make hero" affordance on non-hero thumbs.
  makeHeroBtn: {
    position: 'absolute',
    bottom: 3,
    left: 3,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  makeHeroBtnText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  // D4: the "+ Add photo" tile at the end of the strip.
  addPhotoTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
    gap: 2,
  },
  addPhotoTilePlus: {
    color: colors.primary,
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 24,
  },
  addPhotoTileLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
  },
  webLookupBtn: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    alignItems: 'center',
  },
  webLookupBtnText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  // UI-1: iOS keyboard-accessory bar (Done button) shared by UPC + Description.
  keyboardAccessory: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: colors.surfaceHi,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyboardAccessoryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  keyboardAccessoryText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
});
