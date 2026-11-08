// Lotting session context — holds per-shift defaults shared across all
// lotting screens.
//
// The session is in-memory state that is also persisted to AsyncStorage
// under the key STORAGE_KEY so it survives navigation and app reload.
//
// Usage:
//   import { useLottingSession } from '@/features/lotting/SessionContext';
//   const { session, setSession } = useLottingSession();
//
// The provider wraps the entire lotting sub-stack via lotting/_layout.tsx.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setActiveLottingLoadId } from '@auction-platform/domain-lotting';
import { isLoadPickExpired } from '@/lib/load-pick-expiry';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DefaultCondition = 'appears_new' | 'open_box' | 'good' | 'as_is';

/**
 * D.1 — which manifest identifier field a typed/scanned code should be matched
 * against in find_import_row_by_scan. Maps 1:1 to the RPC's `p_kind` argument
 * (mig 0190). 'auto' (the default) preserves the original multi-column probe
 * behaviour; every other value scopes the lookup to a single column.
 */
export type ScanFieldKind =
  | 'auto'
  | 'upc'
  | 'asin'
  | 'fnsku'
  | 'lpn'
  | 'tracking'
  | 'product_sku'
  | 'model'
  | 'catalog';

/**
 * One row in the persisted "what I've been working on" clipboard.
 * Survives screen navigation and app reload (AsyncStorage backed).
 * Capped at RECENT_HISTORY_MAX entries via a ring-buffer pattern.
 */
export type RecentLotEntry = {
  /** Stable unique id for the React key. NOT the DB UUID. */
  id: string;
  /** The lot's actual database UUID. Use this for navigation to
   *  /inventory/[id] — the lot detail screen queries by `lots.id`,
   *  not by lot_code. Made optional so legacy AsyncStorage entries
   *  written before this field existed don't break the type. Recent
   *  hub renders are guarded on this being set. */
  lotId?: string;
  /** The platform's app-wide unique lot code (e.g. CLU-000123). */
  lotCode: string;
  /** Whatever code was scanned/typed (UPC / FNSKU / model). May be empty. */
  externalCode: string;
  /** Lot title at creation time (operator may have edited since). */
  title: string;
  /** ISO timestamp the entry was added. */
  at: string;
  /** Source/truck/program at time of creation, if set. */
  source?: string;
  /** Pre-stickered label (BRN) bound at creation, if any. When set, recent
   *  cards show this (the physical code on the box) via lotDisplayCode instead
   *  of the canonical lotCode. Null/absent for generate-mode + UUID-QR lots. */
  sticker?: string | null;
};

export type LottingSession = {
  /** Default condition applied to each lot unless overridden per-lot. */
  defaultCondition: DefaultCondition;
  /** Default starting bid in dollars. Defaults to 1. */
  defaultStartBid: number;
  /**
   * The ACTIVE source / truck / program label. Set once at the start
   * of a shift via the Lotting hub picker; every Quick Lot / Scan /
   * Photo / Shelf-scan creation flows it through to lots.source.
   * Empty string = no source set.
   *
   * Operator UX: pick from `recentSources` list rather than retyping
   * each time they switch screens. Adding a new label appends to
   * recentSources too.
   */
  defaultSource: string;
  /**
   * Persistent list of all source labels the operator has ever
   * activated. Capped at 20 entries (most-recent first). Drives the
   * "tap a truck to start lotting" picker on the Lotting hub. Stored
   * here (not in a DB table) so this commit is mobile-only; future
   * commit can promote to a proper lot_sources table for cross-device.
   */
  recentSources: string[];
  /**
   * ISO timestamp of when `defaultSource` was last set/changed. Used to warn
   * when a source has carried over from a previous shift/day so it isn't
   * silently stamped onto today's lots (the "Wayfair items landed under Relot
   * Sedalia" report, 2026-07-16 — the operator's leftover source leaked onto a
   * new day's inventory). Null when no source is set. See `isSourceStale`.
   */
  sourceSetAt: string | null;
  /**
   * The ACTIVE vendor / supplier label (mig 0154). Independent axis
   * from `defaultSource`: source = VRID / Load ID / origin facility,
   * vendor = supplier (Amazon, Lowe's, Wayfair). Set on the Lotting
   * hub and tagged onto every lot created in this session. Empty
   * string = no vendor set.
   */
  defaultVendor: string;
  /**
   * When true, Quick Lot pauses after each scan to offer a photo capture
   * before creating the lot. Default false (rapid-fire stays fast).
   */
  takePhotoAfterScan: boolean;
  /**
   * D.1: the last-used manifest-match field type for Quick Lot's typed/scanned
   * lookups. Persisted across the shift (like takePhotoAfterScan) so the
   * operator's chosen chip sticks between screens and app reloads. Passed
   * straight through as find_import_row_by_scan's `p_kind` (mig 0190).
   * Default 'auto' = today's multi-column probe behaviour.
   */
  scanFieldKind: ScanFieldKind;
  /**
   * When true, Quick Lot's MATCHED (catalog / manifest) path no longer
   * auto-creates after the 2s countdown. Instead it presents a full
   * EditableCandidateCard review so accuracy-minded staff can correct
   * Title / Brand / MSRP / Description before saving. Default false so
   * rapid-fire stays <2s; opt-in per session. Does NOT affect the
   * no-match path (which already shows an explicit 3-button picker).
   */
  reviewBeforeSave: boolean;
  /**
   * W9 slice 3 / mig 0148: structured load ID chosen at the start of a
   * shift. When set, lot creation paths attempt to write lots.load_id.
   * Takes precedence over `defaultSource` for the source pill display;
   * both co-exist so operators who haven't picked a load yet still get
   * the freeform source tag. Null = no load selected.
   */
  defaultLoadId: string | null;
  /**
   * Display name of the selected load (denormalised for fast display).
   * Updated whenever `defaultLoadId` changes. Empty string when no load.
   */
  defaultLoadName: string;
  /**
   * #533: ISO time the load was picked. A pick lasts one working day: the
   * first launch after 04:00 CT clears it (see lib/load-pick-expiry.ts).
   * Set and cleared by setSession whenever `defaultLoadId` changes.
   */
  loadSetAt: string | null;
  /**
   * #533: true after an expired pick was cleared, until staff answer by
   * picking a load, a freeform source, or "No load today". The hub asks
   * before opening a lotting screen while this is set.
   */
  loadPickNeeded: boolean;
  /**
   * Dev-only: show a floating cost HUD across all lotting screens.
   * Exposed via a hidden long-press gesture on the session card label.
   * Default false.
   *
   * Note (W2, 2026-05-26): the prior `useAiPricer` field was removed
   * per plan D4. Quick Lot, Photo, and Scan flows all default starting
   * bid to `defaultStartBid` (typically $1); the operator edits as
   * plain text in the review tab if they want a different start.
   * Existing AsyncStorage entries with `useAiPricer` are ignored on
   * load (spread keeps unknown fields but no code reads them).
   */
  showCostHud: boolean;
  /**
   * Persistent "clipboard" of recent lot creations in this session.
   * Lives here (not in Quick Lot's local state) so it survives
   * navigation away and back. Trimmed to RECENT_HISTORY_MAX.
   */
  recentHistory: RecentLotEntry[];
};

const RECENT_HISTORY_MAX = 20;

const LOAD_EXPIRY_CHECK_MS = 5 * 60_000;

/** #533: clear an expired load pick and ask staff to pick again. */
function expireLoadPick(session: LottingSession): LottingSession {
  return { ...session, defaultLoadId: null, defaultLoadName: '', loadSetAt: null, loadPickNeeded: true };
}

type SessionContextValue = {
  session: LottingSession;
  setSession: (patch: Partial<LottingSession>) => void;
  /** True while the initial AsyncStorage load is in-flight. */
  loading: boolean;
  /**
   * Push a new entry onto the persistent recent-history clipboard.
   * Trims to RECENT_HISTORY_MAX. Use after a successful lot save.
   */
  pushRecentLot: (entry: Omit<RecentLotEntry, 'id' | 'at'> & { at?: string }) => void;
  /** Clear the persistent recent-history (operator action). */
  clearRecentHistory: () => void;
  /**
   * Set the active source AND ensure it's in the recentSources list
   * (moved to the front if already present). Empty string clears the
   * active source without affecting the list.
   */
  setActiveSource: (name: string) => void;
  /** Remove a label from recentSources. Doesn't change the active. */
  removeRecentSource: (name: string) => void;
  /**
   * Set the active vendor / supplier label (mig 0154). Normalized:
   * trimmed + capped at 120 chars (matches lots.vendor CHECK).
   * Empty string clears the vendor.
   */
  setDefaultVendor: (name: string) => void;
};

const RECENT_SOURCES_MAX = 20;

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@lottr/session/v1';

const DEFAULT_SESSION: LottingSession = {
  defaultCondition: 'good', // most common condition in liquidation
  defaultStartBid: 1,
  defaultSource: '',
  recentSources: [],
  sourceSetAt: null,
  defaultVendor: '',
  defaultLoadId: null,
  defaultLoadName: '',
  loadSetAt: null,
  loadPickNeeded: false,
  takePhotoAfterScan: false,
  scanFieldKind: 'auto',
  reviewBeforeSave: false,
  showCostHud: false,
  recentHistory: [],
};

// ── Context ───────────────────────────────────────────────────────────────────

const SessionContext = createContext<SessionContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function LottingSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<LottingSession>(DEFAULT_SESSION);
  const [loading, setLoading] = useState(true);

  // Load from AsyncStorage on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<LottingSession>;
            const restored = { ...DEFAULT_SESSION, ...parsed };
            // #533: drop yesterday's (or a never-dated) pick BEFORE it becomes
            // the active load, so no lot is made against it.
            if (isLoadPickExpired(restored)) {
              const next = expireLoadPick(restored);
              AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
              setSessionState(next);
            } else {
              setSessionState(restored);
            }
          } catch {
            // Corrupted storage — fall back to defaults
          }
        }
      })
      .catch(() => {
        // Storage unavailable — use defaults in-memory
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  // Mig 0428: lots created this shift carry the picked load. Registered at the
  // persistence layer (like the PIN worker), so no create call changes shape
  // and nothing extra goes over the network.
  useEffect(() => {
    setActiveLottingLoadId(session.defaultLoadId);
  }, [session.defaultLoadId]);

  // #533: an iPad can stay open overnight, so the 04:00 CT expiry is also
  // checked when the app comes back to the front and every few minutes.
  useEffect(() => {
    const check = () =>
      setSessionState((prev) => {
        if (!isLoadPickExpired(prev)) return prev;
        const next = expireLoadPick(prev);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
        return next;
      });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    const timer = setInterval(check, LOAD_EXPIRY_CHECK_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  const setSession = useCallback((patch: Partial<LottingSession>) => {
    setSessionState((prev) => {
      const next = { ...prev, ...patch };
      // #533: any change to the load (pick, clear, freeform source) dates the
      // pick and answers an outstanding "pick again" prompt.
      if ('defaultLoadId' in patch) {
        next.loadSetAt = patch.defaultLoadId ? new Date().toISOString() : null;
        next.loadPickNeeded = false;
      }
      // Persist change in background — don't block the UI update
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {
        // Best-effort only; UI stays updated even if storage fails
      });
      return next;
    });
  }, []);

  const pushRecentLot = useCallback(
    (entry: Omit<RecentLotEntry, 'id' | 'at'> & { at?: string }) => {
      // BUG FIX (2026-05-11): the prior version never copied lotId
      // onto the persisted entry, so every recent peek card ended up
      // with lotId=undefined. The LotTR hub's nav guard
      // `navigable = !!entry.lotId` was therefore always false → cards
      // rendered at 0.6 opacity with no onPress → user couldn't open
      // recently lotted items from the peek. New entries now carry
      // lotId through to AsyncStorage. Legacy entries already in
      // AsyncStorage stay un-navigable (still no lotId on them) — they
      // age out naturally as new entries push them past
      // RECENT_HISTORY_MAX.
      const full: RecentLotEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        lotCode: entry.lotCode,
        externalCode: entry.externalCode,
        title: entry.title,
        at: entry.at ?? new Date().toISOString(),
        ...(entry.lotId ? { lotId: entry.lotId } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.sticker ? { sticker: entry.sticker } : {}),
      };
      setSessionState((prev) => {
        const nextHistory = [full, ...prev.recentHistory].slice(0, RECENT_HISTORY_MAX);
        const next = { ...prev, recentHistory: nextHistory };
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {
          /* best-effort */
        });
        return next;
      });
    },
    [],
  );

  const clearRecentHistory = useCallback(() => {
    setSessionState((prev) => {
      const next = { ...prev, recentHistory: [] };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const setActiveSource = useCallback((rawName: string) => {
    // Normalize: trim, cap at 120 chars (matches lots.source DB CHECK
    // from migration 0055 — values that exceed are silently snipped
    // server-side anyway; doing it client-side keeps the picker list
    // in lockstep with what gets persisted).
    const name = rawName.trim().slice(0, 120);
    setSessionState((prev) => {
      // Empty input → just clear the active source. Don't touch
      // recentSources so the operator's history isn't accidentally lost.
      if (!name) {
        // Clearing the source clears its age stamp too.
        const next = { ...prev, defaultSource: '', sourceSetAt: null };
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
        return next;
      }
      // Move-to-front: drop existing instance (if any) then prepend.
      // Case-insensitive equality so "Truck 47L" and "truck 47l" don't
      // double up; the operator's chosen casing wins each time.
      const filtered = prev.recentSources.filter(
        (s) => s.toLowerCase() !== name.toLowerCase(),
      );
      const recentSources = [name, ...filtered].slice(0, RECENT_SOURCES_MAX);
      // Stamp the set time so the hub can flag a source that has carried over
      // from an earlier day (0272 follow-on to the source-stamping fix).
      const next = {
        ...prev,
        defaultSource: name,
        recentSources,
        sourceSetAt: new Date().toISOString(),
      };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const removeRecentSource = useCallback((name: string) => {
    setSessionState((prev) => {
      const filtered = prev.recentSources.filter(
        (s) => s.toLowerCase() !== name.toLowerCase(),
      );
      const next = { ...prev, recentSources: filtered };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const setDefaultVendor = useCallback((rawName: string) => {
    // Normalize: trim + cap at 120 chars (matches lots.vendor CHECK
    // from migration 0154 — values that exceed are silently snipped
    // server-side anyway; doing it client-side keeps the picker label
    // in lockstep with what gets persisted).
    const name = rawName.trim().slice(0, 120);
    setSessionState((prev) => {
      const next = { ...prev, defaultVendor: name };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  return (
    <SessionContext.Provider
      value={{
        session,
        setSession,
        loading,
        pushRecentLot,
        clearRecentHistory,
        setActiveSource,
        removeRecentSource,
        setDefaultVendor,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useLottingSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useLottingSession must be used inside <LottingSessionProvider>');
  }
  return ctx;
}

// ── Source-staleness helper ─────────────────────────────────────────────────────

/**
 * True when an active source was last set on an EARLIER calendar day (local
 * time) — i.e. it has carried over from a previous shift and may no longer be
 * the truck/program the operator is actually working. The hub uses this to warn
 * before that stale label gets stamped onto today's lots. Returns false when no
 * source is set or the stamp is missing/today. Compared by local calendar day
 * (not a fixed hour window) because lotting is organized by daily shifts.
 */
/**
 * The source label that lots created right now should actually carry.
 *
 * A structured load (picked from the manager's Loads list) wins over the
 * freeform `defaultSource`, exactly as `defaultLoadName`'s own doc comment
 * has always claimed. Only the Lotting hub honoured that; every creation
 * screen read `defaultSource` directly, so picking "Wayfair August" left
 * lots stamped with whatever freeform label was last typed — reported
 * 2026-08-26 as Quick Lot flipping the selection to "Dodge Relots" with no
 * way to change it back. The hub showed the load, Quick Lot showed the stale
 * source, and the lots got the stale source.
 *
 * One helper so display and persistence can never disagree again.
 */
export function activeLotSource(
  session: Pick<LottingSession, 'defaultSource' | 'defaultLoadName'>,
): string {
  const load = session.defaultLoadName?.trim();
  if (load) return load;
  return session.defaultSource?.trim() ?? '';
}

export function isSourceStale(session: Pick<LottingSession, 'defaultSource' | 'sourceSetAt'>): boolean {
  if (!session.defaultSource || !session.sourceSetAt) return false;
  const set = new Date(session.sourceSetAt);
  if (isNaN(set.getTime())) return false;
  return set.toDateString() !== new Date().toDateString();
}

// ── Display helpers ───────────────────────────────────────────────────────────

export const CONDITION_LABELS: Record<DefaultCondition, string> = {
  appears_new: 'Appears New',
  open_box: 'Open Box',
  good: 'Good',
  as_is: 'As-Is',
};

export const CONDITION_COLORS: Record<DefaultCondition, string> = {
  appears_new: '#22c55e',
  open_box: '#5cacff',
  good: '#ffb347',
  as_is: '#ff5c5c',
};

export const ALL_CONDITIONS: DefaultCondition[] = [
  'appears_new',
  'open_box',
  'good',
  'as_is',
];

// ── D.1 scan-field picker helpers ───────────────────────────────────────────────

/** Short chip labels for each manifest-match field kind. */
export const SCAN_FIELD_LABELS: Record<ScanFieldKind, string> = {
  auto: 'Auto-detect',
  upc: 'UPC',
  asin: 'ASIN',
  fnsku: 'FNSKU',
  lpn: 'LPN',
  tracking: 'Tracking',
  product_sku: 'Product SKU',
  model: 'Model',
  catalog: 'Catalog ID',
};

/**
 * Placeholder copy for the manual-code input, per chosen field kind. 'auto'
 * keeps the original broad hint; the rest name the single field being matched.
 */
export const SCAN_FIELD_PLACEHOLDERS: Record<ScanFieldKind, string> = {
  auto: 'UPC, ASIN, FNSKU, LPN, model number, or any code',
  upc: 'Enter UPC',
  asin: 'Enter ASIN',
  fnsku: 'Enter FNSKU',
  lpn: 'Enter LPN',
  tracking: 'Enter tracking number',
  product_sku: 'Enter Product SKU',
  model: 'Enter model number',
  catalog: 'Enter Catalog ID',
};

/** Chip render order. 'auto' first (it's the default). */
export const ALL_SCAN_FIELD_KINDS: ScanFieldKind[] = [
  'auto',
  'upc',
  'asin',
  'fnsku',
  'lpn',
  'tracking',
  'product_sku',
  'model',
  'catalog',
];
