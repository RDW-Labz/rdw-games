// LotTR Mobile — redesigned hub.
//
// Mental model the layout supports (top→bottom):
//   STATUS  → who am I, what truck, how many lots so far
//   HEROES  → the two creation modes I'll tap 200×/shift (AI Photo + Quick Lot)
//   FALLBACK → less-common modes (UPC/keyword search, inventory, trash)
//   SESSION → collapsed summary; tap to open a bottom sheet for config
//   RECENT   → horizontal peek of the last few lots (only if any)
//
// What this replaces:
//   - Header block "LOTTR MOBILE / Create lots" (decoration, runtime-useless)
//   - Always-expanded session card eating 45-55% of the screen
//   - Three creation TILES where the most-valuable mode (AI Photo) was
//     hidden as a sub-tab of the "Scan" tile destination
//   - Active source picker that could push tiles off the screen when expanded
//
// Operator workflow this enables:
//   - Open app → see source + count → see AI PHOTO SCAN big & loud → tap.
//   - Config is one tap away via the session strip, then out of the way.

import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  SafeAreaView,
  ScrollView,
  TextInput,
  Switch,
  Modal,
  StyleSheet,
  Alert,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { colors } from '@auction-platform/design-system';
import {
  useLottingSession,
  isSourceStale,
  ALL_CONDITIONS,
  CONDITION_LABELS,
  CONDITION_COLORS,
  type DefaultCondition,
} from '@/features/lotting/SessionContext';
import { LottingModeToggle } from '@/features/lotting/LottingModeToggle';
import { useLoadsList, type LoadRow } from '@/features/lotting/useLoadsList';
import { parseCents, centsToDollars } from '@auction-platform/domain-lotting';
import { supabase } from '@auction-platform/supabase-client';
import { drainPendingLots } from '@/lib/pending-lot-queue';

// ── Daily counter hook ────────────────────────────────────────────────────────

function useTodayLotCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { count: n, error } = await supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', today.toISOString())
        .is('deleted_at', null);
      if (cancelled) return;
      if (error || n === null) setCount(null);
      else setCount(n);
    })();
    return () => { cancelled = true; };
  }, []);
  return count;
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function LottingHome() {
  const { session, loading } = useLottingSession();
  const router = useRouter();
  const todayCount = useTodayLotCount();
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);

  // Finish any create that never came back. The hub is where staff land at the
  // start of a shift and return to between items — the natural moment for a
  // lot stranded by the previous session to quietly complete. Must sit above
  // the `loading` early-return below: hooks cannot run conditionally.
  const drainedRef = useRef(false);
  useEffect(() => {
    if (drainedRef.current) return;
    drainedRef.current = true;
    void (async () => {
      const { recovered } = await drainPendingLots();
      if (recovered.length === 0) return;
      Alert.alert(
        recovered.length === 1
          ? 'Recovered an unfinished lot'
          : `Recovered ${recovered.length} unfinished lots`,
        `Saved after the app closed before finishing: ${recovered.join(', ')}.\n\n` +
          'Any photos that had already uploaded are attached. Check the item is ' +
          'still where you left it before it goes out.',
      );
    })();
  }, []);

  if (loading) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  // Session summary line for the collapsed strip. Shows the three
  // most relevant config values so the operator can verify without
  // opening the sheet.
  // W2 (2026-05-26): dropped the 'AI pricing ON/OFF' chip per plan D4.
  // Quick Lot / Photo / Scan all default to defaultStartBid now — there
  // is no AI-pricing toggle to summarize.
  const sessionSummary = [
    CONDITION_LABELS[session.defaultCondition],
    `$${session.defaultStartBid.toFixed(2)}`,
  ].join(' · ');

  // Display label: load name (when set) takes precedence over freeform source.
  const displaySource = session.defaultLoadName || session.defaultSource;
  const hasSource = displaySource.length > 0;
  // Warn (non-blocking) when the active source carried over from an earlier day
  // so it isn't silently stamped onto today's lots. A load (defaultLoadId) is an
  // explicit structured pick, so only the freeform source goes stale.
  const sourceStale = hasSource && !session.defaultLoadId && isSourceStale(session);
  // #533: yesterday's load was cleared at 04:00 CT. Lotting screens open the
  // picker first until staff pick a load, a source, or "No load today".
  const mustPickLoad = session.loadPickNeeded;
  const openLotting = (href: '/lotting/photo' | '/lotting/quick' | '/lotting/manual' | '/lotting/relot') => {
    if (mustPickLoad) setSourceSheetOpen(true);
    else router.push(href);
  };
  const recentHistory = session.recentHistory.slice(0, 4);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 80, gap: 14 }}
      >
        {/* ─── ZONE 1: Status row ──────────────────────────────────────── */}
        {/* Compact: active source on the left (tap to change), today's
            count on the right. Replaces the entire ActiveSourceCard +
            "X lots today" chip from the previous layout. */}
        <View style={s.statusRow}>
          <Pressable
            onPress={() => setSourceSheetOpen(true)}
            style={[
              s.sourcePill,
              hasSource && s.sourcePillActive,
              sourceStale && { borderColor: colors.winning },
            ]}
          >
            <Text
              style={[
                s.sourcePillText,
                hasSource && { color: sourceStale ? colors.winning : colors.primary },
              ]}
              numberOfLines={1}
            >
              {sourceStale
                ? `⚠ ${displaySource}`
                : hasSource
                  ? displaySource
                  : 'Set a truck / source'}
            </Text>
            <Text style={s.sourcePillIcon}>🖉</Text>
          </Pressable>
          {todayCount !== null && (
            <View style={s.countChip}>
              <Text style={s.countNumber}>{todayCount}</Text>
              <Text style={s.countLabel}>today</Text>
            </View>
          )}
        </View>

        {/* Stale-source warning: the active source carried over from an earlier
            day. Non-blocking — a tap opens the source picker to confirm/change.
            Prevents yesterday's truck/program from silently tagging today's
            lots (2026-07-16 "Wayfair items under Relot Sedalia" report). */}
        {sourceStale && (
          <Pressable onPress={() => setSourceSheetOpen(true)}>
            <Text
              style={{
                color: colors.winning,
                fontSize: 12,
                fontWeight: '700',
                paddingHorizontal: 4,
              }}
            >
              “{displaySource}” was set on an earlier day — tap to confirm or change it before lotting.
            </Text>
          </Pressable>
        )}

        {mustPickLoad && (
          <Pressable onPress={() => setSourceSheetOpen(true)}>
            <Text
              style={{
                color: colors.winning,
                fontSize: 12,
                fontWeight: '700',
                paddingHorizontal: 4,
              }}
            >
              Pick today's load before lotting. Yesterday's load was cleared. Tap to pick.
            </Text>
          </Pressable>
        )}

        {/* ─── Lotting mode indicator ──────────────────────────────────── */}
        {/* Lets the operator confirm (or switch) sticker mode without
            entering a creation sub-screen. Mirrors the toggle already
            shown on each entry screen. */}
        <LottingModeToggle />

        {/* ─── ZONE 2: Hero buttons ────────────────────────────────────── */}
        {/* AI Photo Scan is the dominant element — biggest, brightest,
            top of the action zone. Quick Lot sits underneath at
            secondary weight. These two cover 90% of a lotter's
            actual workflow. */}
        <Pressable style={s.heroPrimary} onPress={() => openLotting('/lotting/photo')}>
          <Text style={s.heroIcon}>📷</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.heroPrimaryLabel}>AI Photo Scan</Text>
            <Text style={s.heroPrimarySub}>Snap — AI identifies instantly</Text>
          </View>
          <Text style={s.heroPrimaryChevron}>›</Text>
        </Pressable>

        <Pressable style={s.heroSecondary} onPress={() => openLotting('/lotting/quick')}>
          <Text style={s.heroIcon}>⚡</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.heroSecondaryLabel}>Quick Lot</Text>
            <Text style={s.heroSecondarySub}>Barcode → done in 2 s</Text>
          </View>
          <Text style={s.heroSecondaryChevron}>›</Text>
        </Pressable>

        {/* ─── ZONE 3: Secondary actions ───────────────────────────────── */}
        {/* W2-rest: Web Lookup tile removed from hub. Web lookup is now
            embedded inside ConfirmationCard (quick.tsx) and
            EditableCandidateCard so operators access it contextually.
            UPC/Type link removed — UPC tab is legacy (removed from scan.tsx). */}
        {/* Compact link row. Less common modes that shouldn't compete
            visually with the heroes but should be one tap from the hub. */}
        <View style={s.secondaryRow}>
          <Link href="/worklist" asChild>
            <Pressable style={s.secondaryLink}>
              <Text style={s.secondaryLinkIcon}>📋</Text>
              <Text style={s.secondaryLinkText}>Inventory</Text>
            </Pressable>
          </Link>
          <Pressable style={s.secondaryLink} onPress={() => openLotting('/lotting/manual')}>
            <Text style={s.secondaryLinkIcon}>✏️</Text>
            <Text style={s.secondaryLinkText}>Manual lot</Text>
          </Pressable>
          {/* Relot (Jared recap 2026-07-07): returned/unsold items get a NEW
              listing with a new code + fresh photos, keeping lineage — not a
              from-scratch manual lot. */}
          <Pressable style={s.secondaryLink} onPress={() => openLotting('/lotting/relot')}>
            <Text style={s.secondaryLinkIcon}>🔁</Text>
            <Text style={s.secondaryLinkText}>Relot</Text>
          </Pressable>
        </View>

        {/* ─── ZONE 4: Session strip (collapsed) ───────────────────────── */}
        {/* One-line summary of every session toggle + condition + bid.
            Tap → opens a Modal sheet with the full controls. Out of the
            way 95% of the time, one tap when you need it. */}
        <Pressable
          onPress={() => setSessionSheetOpen(true)}
          style={s.sessionStrip}
        >
          <Text style={s.sessionStripIcon}>⚙</Text>
          <Text style={s.sessionStripText} numberOfLines={1}>
            {sessionSummary}
          </Text>
          <Text style={s.sessionStripChevron}>›</Text>
        </Pressable>

        {/* ─── ZONE 5: Recent history peek (conditional) ──────────────── */}
        {/* Bug fix (b4 → b5): entry.id is a synthetic React-key
            (Date.now()+random). The lot's actual DB UUID lives in
            entry.lotId. Routing on entry.id pushed a non-UUID string
            into /inventory/[id] which crashed with a Postgres 22P02
            "invalid input syntax for type uuid" error. Now we route
            on lotId; legacy entries pre-dating the field are read-
            only (no chevron, no tap target) since we can't safely
            resolve them. */}
        {recentHistory.length > 0 && (
          <View style={{ marginTop: 4 }}>
            <Text style={s.recentLabel}>Recent</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {recentHistory.map((entry) => {
                const navigable = !!entry.lotId;
                return (
                  <Pressable
                    key={entry.id}
                    onPress={
                      navigable
                        ? () => router.push(`/worklist/${entry.lotId}`)
                        : undefined
                    }
                    style={[s.recentCard, !navigable && { opacity: 0.6 }]}
                  >
                    <Text style={s.recentCode}>{entry.lotCode}</Text>
                    <Text style={s.recentTitle} numberOfLines={2}>
                      {entry.title}
                    </Text>
                    {entry.source && (
                      <Text style={s.recentSource} numberOfLines={1}>
                        {entry.source}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* ─── Bottom sheets ──────────────────────────────────────────────── */}
      <SessionSheet
        visible={sessionSheetOpen}
        onClose={() => setSessionSheetOpen(false)}
      />
      <SourceSheet
        visible={sourceSheetOpen}
        onClose={() => setSourceSheetOpen(false)}
      />
    </SafeAreaView>
  );
}

// ── SessionSheet ──────────────────────────────────────────────────────────────
// Bottom-sheet modal containing condition chips, starting bid input,
// and the three boolean toggles (takePhotoAfterScan, useAiPricer,
// showCostHud). Replaces the always-visible session card from the
// previous design.

function SessionSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { session, setSession } = useLottingSession();
  const [editingBid, setEditingBid] = useState(false);
  const [bidInput, setBidInput] = useState('');

  function handleBidBlur() {
    const cents = parseCents(bidInput);
    if (cents != null && cents > 0) {
      setSession({ defaultStartBid: cents / 100 });
    }
    setEditingBid(false);
    setBidInput('');
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.sheetBackdrop} onPress={onClose}>
        <Pressable style={s.sheetContainer} onPress={(e) => e.stopPropagation()}>
          <View style={s.sheetHandle} />
          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
            <Text style={s.sheetHeading}>Session defaults</Text>

            {/* Condition chips */}
            <View>
              <Text style={s.sheetLabel}>Default condition</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {ALL_CONDITIONS.map((cond: DefaultCondition) => {
                  const active = session.defaultCondition === cond;
                  const col = CONDITION_COLORS[cond];
                  return (
                    <Pressable
                      key={cond}
                      onPress={() => setSession({ defaultCondition: cond })}
                      style={[
                        s.condChip,
                        active && {
                          backgroundColor: `${col}22`,
                          borderColor: `${col}66`,
                        },
                      ]}
                    >
                      <Text
                        style={[s.condChipText, active && { color: col }]}
                      >
                        {CONDITION_LABELS[cond]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Starting bid */}
            <View>
              <Text style={s.sheetLabel}>Default starting bid</Text>
              {editingBid ? (
                <TextInput
                  value={bidInput}
                  onChangeText={setBidInput}
                  onBlur={handleBidBlur}
                  onSubmitEditing={handleBidBlur}
                  keyboardType="decimal-pad"
                  autoFocus
                  style={s.bidInput}
                  placeholder="1.00"
                  placeholderTextColor={colors.textMuted}
                />
              ) : (
                <Pressable
                  onPress={() => {
                    setBidInput(session.defaultStartBid.toFixed(2));
                    setEditingBid(true);
                  }}
                  style={s.bidPill}
                >
                  <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '800' }}>
                    {centsToDollars(Math.round(session.defaultStartBid * 100))}
                  </Text>
                  <Text style={{ color: colors.textDim, fontSize: 12, marginLeft: 6 }}>
                    ✎
                  </Text>
                </Pressable>
              )}
            </View>

            {/* Toggles */}
            <ToggleRow
              label="Take photo after scan"
              hint="Pause after each Quick Lot scan to add a photo."
              value={session.takePhotoAfterScan}
              onValueChange={(v) => setSession({ takePhotoAfterScan: v })}
            />
            {/* W2 (2026-05-26): "Use AI starting bid" toggle removed per
                plan D4. All Scan/Photo lots default to defaultStartBid;
                operator edits per-lot in the review screen. */}
            <ToggleRow
              label="Show cost HUD"
              hint="Floating tracker for token + USD cost on every AI call."
              value={session.showCostHud}
              onValueChange={(v) => setSession({ showCostHud: v })}
            />

            <Pressable onPress={onClose} style={s.sheetDoneBtn}>
              <Text style={s.sheetDoneBtnText}>Done</Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={s.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        <Text style={s.toggleHint}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.surfaceHi, true: colors.primaryDim }}
        thumbColor={value ? colors.primary : colors.textDim}
      />
    </View>
  );
}

// ── SourceSheet ───────────────────────────────────────────────────────────────
// Bottom-sheet modal for picking the active truck / source. Includes
// the recent list, an "Add new" inline input, and a "Stop tagging"
// link. Replaces the always-visible ActiveSourceCard.

function SourceSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { session, setSession, setActiveSource, removeRecentSource, setDefaultVendor } = useLottingSession();
  const [draft, setDraft] = useState('');
  const [vendorDraft, setVendorDraft] = useState(session.defaultVendor);
  const active = session.defaultSource;
  const recent = session.recentSources;
  const loadsState = useLoadsList();

  // Keep the vendor draft in sync with the session value whenever the sheet
  // reopens. Without this, a vendor edit made elsewhere (or a fresh session
  // load from AsyncStorage) wouldn't reflect in the input the next time the
  // operator opens the source/vendor sheet.
  useEffect(() => {
    if (visible) setVendorDraft(session.defaultVendor);
  }, [visible, session.defaultVendor]);

  function commitNew() {
    const v = draft.trim();
    if (!v) return;
    // Clear any load selection when operator types a freeform source.
    setSession({ defaultLoadId: null, defaultLoadName: '' });
    setActiveSource(v);
    setDraft('');
    onClose();
  }

  function pick(name: string) {
    setSession({ defaultLoadId: null, defaultLoadName: '' });
    setActiveSource(name);
    onClose();
  }

  function pickLoad(load: LoadRow) {
    // Set both the structured load ID and a display name. Keep defaultSource
    // unchanged as fallback for lots created without a load.
    setSession({
      defaultLoadId: load.id,
      defaultLoadName: load.source_name,
    });
    onClose();
  }

  function clearLoad() {
    setSession({ defaultLoadId: null, defaultLoadName: '' });
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.sheetBackdrop} onPress={onClose}>
        <Pressable style={s.sheetContainer} onPress={(e) => e.stopPropagation()}>
          <View style={s.sheetHandle} />
          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
            <Text style={s.sheetHeading}>Source / Truck</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              Pick once at the start of a shift — every Quick Lot / Photo /
              Scan after this tags lots.source / load_id. View the filtered
              inventory via the Recent peek on the hub or the Inventory tab.
            </Text>

            {/* #533: yesterday's pick was cleared at 04:00 CT. Ask, and offer an
                explicit "no load" answer for lots that don't belong to one. */}
            {session.loadPickNeeded && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.winning, fontSize: 13, fontWeight: '700' }}>
                  Yesterday's load was cleared. Pick today's load below, or:
                </Text>
                <Pressable
                  onPress={() => {
                    clearLoad();
                    onClose();
                  }}
                  style={s.sourceRow}
                >
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>No load today</Text>
                </Pressable>
              </View>
            )}

            {/* W9 slice 3: Load picker — structured loads from the loads table */}
            {loadsState.status === 'ok' && loadsState.loads.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={s.sheetLabel}>Loads (from manager)</Text>
                {loadsState.loads.map((load) => {
                  const isActive = session.defaultLoadId === load.id;
                  return (
                    <Pressable
                      key={load.id}
                      onPress={() => pickLoad(load)}
                      style={[
                        s.sourceRow,
                        isActive && {
                          backgroundColor: colors.primaryDim,
                          borderColor: `${colors.primary}66`,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          style={{
                            color: isActive ? colors.primary : colors.text,
                            fontSize: 14,
                            fontWeight: isActive ? '800' : '600',
                          }}
                          numberOfLines={1}
                        >
                          {isActive ? '✓ ' : ''}{load.source_name}
                        </Text>
                        <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                          {load.type === 'auto-import' ? 'import' : 'manual'}
                          {' · '}
                          {new Date(load.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
                {session.defaultLoadId && (
                  <Pressable onPress={clearLoad}>
                    <Text style={{ color: colors.textMuted, fontSize: 12, textDecorationLine: 'underline' }}>
                      Clear load selection
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
            {loadsState.status === 'loading' && (
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Loading loads…</Text>
            )}

            {/* Freeform source fallback */}
            <View style={{ gap: 6 }}>
              <Text style={s.sheetLabel}>Ad-hoc source (freeform)</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                Source = where it came from (VRID / Load ID / facility).
                Use when no load is set up in the manager console yet.
              </Text>
            </View>

            {/* Recent freeform list */}
            {recent.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={s.sheetLabel}>Recent</Text>
                {recent.map((name) => {
                  const isActive = !session.defaultLoadId && name.toLowerCase() === active.toLowerCase();
                  return (
                    <View
                      key={name}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    >
                      <Pressable
                        onPress={() => pick(name)}
                        style={[
                          s.sourceRow,
                          isActive && {
                            backgroundColor: colors.primaryDim,
                            borderColor: `${colors.primary}66`,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: isActive ? colors.primary : colors.text,
                            fontSize: 14,
                            fontWeight: isActive ? '800' : '600',
                          }}
                          numberOfLines={1}
                        >
                          {isActive ? '✓ ' : ''}
                          {name}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => removeRecentSource(name)}
                        hitSlop={6}
                        style={s.sourceRowRemove}
                      >
                        <Text style={{ color: colors.textDim, fontSize: 14 }}>×</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Inline add */}
            <View style={{ gap: 6 }}>
              <Text style={s.sheetLabel}>Add new</Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder='e.g. "Truck 47L 5/9"'
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  autoCapitalize="words"
                  style={[s.sourceInput, { flex: 1 }]}
                  onSubmitEditing={commitNew}
                  returnKeyType="done"
                  maxLength={120}
                />
                <Pressable
                  onPress={commitNew}
                  disabled={!draft.trim()}
                  style={[s.sourceAddBtn, !draft.trim() && { opacity: 0.4 }]}
                >
                  <Text style={{ color: '#000', fontWeight: '900', fontSize: 14 }}>
                    Add
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Vendor (supplier) — independent axis from source (mig 0154).
                Source answers "where did it come from?" (VRID/load/facility);
                vendor answers "who supplied it?" (Amazon / Lowe's / Wayfair).
                Persists to lots.vendor for every lot created in this session.
                Onblur commit so rapid typing doesn't fire a write per
                keystroke. */}
            <View style={{ gap: 6 }}>
              <Text style={s.sheetLabel}>Vendor (supplier)</Text>
              <TextInput
                value={vendorDraft}
                onChangeText={setVendorDraft}
                onBlur={() => setDefaultVendor(vendorDraft)}
                onSubmitEditing={() => setDefaultVendor(vendorDraft)}
                placeholder="Amazon / Lowe's / Wayfair"
                placeholderTextColor={colors.textMuted}
                autoCorrect={false}
                autoCapitalize="words"
                style={s.sourceInput}
                returnKeyType="done"
                maxLength={120}
              />
            </View>

            {/* Stop tagging */}
            {(active || session.defaultLoadId) && (
              <Pressable
                onPress={() => {
                  clearLoad();
                  setActiveSource('');
                  onClose();
                }}
              >
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: 13,
                    textDecorationLine: 'underline',
                  }}
                >
                  Stop tagging (keeps recent list)
                </Text>
              </Pressable>
            )}

            <Pressable onPress={onClose} style={s.sheetDoneBtn}>
              <Text style={s.sheetDoneBtnText}>Done</Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // ZONE 1: Status row
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sourcePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sourcePillActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(255,122,0,0.12)',
  },
  sourcePillText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '800',
  },
  sourcePillIcon: {
    color: colors.textMuted,
    fontSize: 12,
  },
  countChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  countNumber: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '900',
  },
  countLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },

  // ZONE 2: Heroes
  heroPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 22,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: 'rgba(255,122,0,0.10)',
    minHeight: 110,
  },
  heroSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    minHeight: 80,
  },
  heroIcon: {
    fontSize: 36,
    lineHeight: 40,
  },
  heroPrimaryLabel: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  heroPrimarySub: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 3,
  },
  heroPrimaryChevron: {
    color: colors.primary,
    fontSize: 32,
    fontWeight: '300',
  },
  heroSecondaryLabel: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  heroSecondarySub: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  heroSecondaryChevron: {
    color: colors.textMuted,
    fontSize: 26,
    fontWeight: '300',
  },

  // ZONE 3: Secondary row
  secondaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  secondaryLink: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  secondaryLinkIcon: {
    fontSize: 14,
  },
  secondaryLinkText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },

  // ZONE 4: Session strip
  sessionStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sessionStripIcon: {
    color: colors.textMuted,
    fontSize: 16,
  },
  sessionStripText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  sessionStripChevron: {
    color: colors.textMuted,
    fontSize: 18,
  },

  // ZONE 5: Recent peek
  recentLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  recentCard: {
    width: 140,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4,
  },
  recentCode: {
    color: colors.primary,
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
  recentTitle: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 16,
  },
  recentSource: {
    color: colors.textMuted,
    fontSize: 10,
  },

  // ── Bottom sheet shared ────────────────────────────────────────────────────
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    maxHeight: '85%',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  sheetHeading: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  sheetLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  sheetDoneBtn: {
    marginTop: 6,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  sheetDoneBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '900',
  },

  // Condition chips
  condChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    minHeight: 36,
    justifyContent: 'center',
  },
  condChipText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },

  // Bid pill
  bidPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.primary}44`,
    backgroundColor: colors.primaryDim,
    alignSelf: 'flex-start',
  },
  bidInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    width: 100,
    textAlign: 'right',
  },

  // Toggle rows inside session sheet
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  toggleLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  toggleHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },

  // Source sheet rows
  sourceRow: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  sourceRowRemove: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  sourceInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  sourceAddBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
