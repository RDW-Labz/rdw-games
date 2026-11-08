// Active-worker context — the per-worker PIN identity layered on top of the
// device's shared operator_users (station) login (#2, 2026-07-21).
//
// The device authenticates ONCE as a company staff account (useOperatorRole).
// On top of that, each worker "clocks in" with a short PIN so the app knows WHO
// is working — for attribution (lots.lotted_by_worker), role-gating by the
// worker's role, and a name on screen — without anyone needing a personal email.
//
// This is app-level identity only: it does NOT change the Supabase session, so
// it never triggers the token-refresh sign-out churn that shared per-person
// logins caused. The active worker is persisted to AsyncStorage so a reload /
// crash keeps the same worker clocked in until they clock out or switch.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setActiveLottingWorkerId } from '@auction-platform/domain-lotting';
import { useOperatorRole, type OperatorRole } from '@auction-platform/supabase-client';

export type ActiveWorker = {
  id: string;
  displayName: string;
  role: string; // operator_user_role: admin | manager | lead | picker
  operatorId: string;
};

type WorkerContextValue = {
  worker: ActiveWorker | null;
  /** True once the persisted worker (if any) has loaded from AsyncStorage. */
  ready: boolean;
  clockIn: (w: ActiveWorker) => void;
  clockOut: () => void;
  /** Whether the clock-in / switch-employee sheet is open. */
  switcherOpen: boolean;
  /** Open the in-app clock-in / switch-employee sheet (header button, home pill). */
  openSwitcher: () => void;
  closeSwitcher: () => void;
};

const STORAGE_KEY = 'bingo.activeWorker.v1';

const WorkerContext = createContext<WorkerContextValue>({
  worker: null,
  ready: false,
  clockIn: () => {},
  clockOut: () => {},
  switcherOpen: false,
  openSwitcher: () => {},
  closeSwitcher: () => {},
});

export function WorkerProvider({ children }: { children: React.ReactNode }) {
  const [worker, setWorker] = useState<ActiveWorker | null>(null);
  const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const parsed = JSON.parse(raw) as Partial<ActiveWorker>;
          if (parsed && parsed.id && parsed.operatorId && parsed.displayName) {
            setWorker(parsed as ActiveWorker);
            setActiveLottingWorkerId((parsed as ActiveWorker).id);
          }
        } catch {
          // Corrupt entry — ignore; the worker just clocks in again.
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clockIn = useCallback((w: ActiveWorker) => {
    setWorker(w);
    setActiveLottingWorkerId(w.id);
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(w)).catch(() => {});
  }, []);

  const clockOut = useCallback(() => {
    setWorker(null);
    setActiveLottingWorkerId(null);
    void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  return (
    <WorkerContext.Provider
      value={{ worker, ready, clockIn, clockOut, switcherOpen, openSwitcher, closeSwitcher }}
    >
      {children}
    </WorkerContext.Provider>
  );
}

export function useActiveWorker(): WorkerContextValue {
  return useContext(WorkerContext);
}

/**
 * The role that should gate staff-app actions on a shared device: the clocked-in
 * WORKER's role when one is active, else the device's operator_users role. Use
 * this instead of useOperatorRole().role for gates so a manager working on a
 * picker-logged-in shared phone gets manager access (and a picker on a manager-
 * logged-in device is held to picker). Falls back to the device role when no
 * worker is clocked in (individual-login mode / pre-rollout).
 */
export function useEffectiveRole(): OperatorRole | null {
  const { worker } = useActiveWorker();
  const role = useOperatorRole();
  const deviceRole = role.kind === 'staff' ? role.role : null;
  return (worker?.role as OperatorRole | undefined) ?? deviceRole;
}
