// Session-scoped lotting mode preference. Persisted to AsyncStorage so the
// operator's choice survives app restarts. Every shift starts in the mode
// they last used — avoids silent "generate" resets when the pre-stickered
// workflow is active.
//
//   'generate'      — existing default. Lot is created with its
//                     auto-generated qr_token; operator prints the
//                     sticker via /api/lots/qr-sheet later.
//   'prestickered'  — after lot creation, run a camera scan step:
//                     scan a pre-printed sticker → claim_prestickered_qr
//                     rotates the lot's qr_token to the scanned UUID.
//   'lpn_sticker'   — W2-bonus (mig 0141). After lot creation, scan or
//                     type an arbitrary code (LPN from manifest, vendor
//                     sticker, etc.) → claim_sticker_code binds it to
//                     lots.sticker_code in `{op.code}:{raw}` format.
//                     Intake resolution will pick this up via lane 3.
//
// Lives at the (staff)/lotting/_layout.tsx level so all four entry
// screens share the same selection.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type LottingMode = 'generate' | 'prestickered' | 'lpn_sticker';

// Exported so callers (e.g. record-bidder-demo.mjs debug helpers) can
// reference the exact key without hard-coding a string.
export const LOTTING_MODE_STORAGE_KEY = '@lottr/lotting-mode/v1';

interface LottingModeState {
  mode: LottingMode;
  setMode: (mode: LottingMode) => void;
  /** True while the initial AsyncStorage load is in-flight. */
  loading: boolean;
}

const LottingModeContext = createContext<LottingModeState | null>(null);

export function LottingModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<LottingMode>('generate');
  const [loading, setLoading] = useState(true);

  // Load persisted mode on mount
  useEffect(() => {
    AsyncStorage.getItem(LOTTING_MODE_STORAGE_KEY)
      .then((raw) => {
        if (raw === 'generate' || raw === 'prestickered' || raw === 'lpn_sticker') {
          setModeState(raw);
        }
      })
      .catch(() => {
        // Storage unavailable — use default in-memory
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const setMode = useCallback((next: LottingMode) => {
    setModeState(next);
    // Persist in background — don't block the UI update
    AsyncStorage.setItem(LOTTING_MODE_STORAGE_KEY, next).catch(() => {
      // Best-effort only; UI stays updated even if storage fails
    });
  }, []);

  const value = useMemo<LottingModeState>(
    () => ({ mode, setMode, loading }),
    [mode, setMode, loading],
  );

  return (
    <LottingModeContext.Provider value={value}>
      {children}
    </LottingModeContext.Provider>
  );
}

/** Read + set the active lotting mode. Safe to call from any screen
 *  rendered under the lotting Stack — returns the 'generate' default
 *  if the provider is somehow absent (defensive: keeps screens working
 *  even if a routing change skips the layout). */
export function useLottingMode(): LottingModeState {
  const ctx = useContext(LottingModeContext);
  if (!ctx) {
    // Defensive fallback so a misconfigured route doesn't crash the
    // lotting screens. The provider lives in lotting/_layout.tsx so
    // this should never fire in normal use.
    return {
      mode: 'generate',
      setMode: () => undefined,
      loading: false,
    };
  }
  return ctx;
}
