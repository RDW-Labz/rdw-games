// Active-warehouse context — which building this device is working in.
//
// Why this exists (multi-location audit 2026-07-27): BinGo ran on one warehouse
// until Dodge City (KS) was created alongside Harrison (AR). The staff app had
// NO warehouse concept at all — every query is RLS-scoped to the OPERATOR, so
// bin lists silently merged Harrison's 518 bins with Dodge City's 30 with no
// indication which building any of them is in. Bin codes look alike across
// locations (`4-16-02` is a plausible code in both), so this quietly invited
// putting stock in the wrong building.
//
// Modelled deliberately on WorkerContext: app-level state only, persisted to
// AsyncStorage, hoisted at the (staff) layout, with a header button opening a
// switcher sheet. It does NOT touch the Supabase session.
//
// Semantics chosen to fail SAFE:
//   • There is no "all warehouses" option. A physical worker is standing in one
//     building; an ambiguous view is the bug we are fixing.
//   • Single-warehouse operators are auto-selected and never see the picker, so
//     nothing changes for them.
//   • With >1 warehouse and nothing chosen, `warehouse` is null and screens are
//     expected to prompt rather than guess. Guessing is what produced the bug.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';
import { isWarehouseActive } from './warehouse-active';

export type ActiveWarehouse = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
};

type WarehouseContextValue = {
  /** The building this device is working in. Null = not yet chosen. */
  warehouse: ActiveWarehouse | null;
  /** Every warehouse this operator has, for the picker. */
  available: ActiveWarehouse[];
  /** True once the persisted choice AND the warehouse list have loaded. */
  ready: boolean;
  /** True when the operator has >1 warehouse — i.e. the picker is meaningful. */
  multiLocation: boolean;
  select: (w: ActiveWarehouse) => void;
  switcherOpen: boolean;
  openSwitcher: () => void;
  closeSwitcher: () => void;
};

const STORAGE_KEY = 'bingo.activeWarehouse.v1';

const WarehouseContext = createContext<WarehouseContextValue>({
  warehouse: null,
  available: [],
  ready: false,
  multiLocation: false,
  select: () => {},
  switcherOpen: false,
  openSwitcher: () => {},
  closeSwitcher: () => {},
});

export function WarehouseProvider({ children }: { children: React.ReactNode }) {
  const [warehouse, setWarehouse] = useState<ActiveWarehouse | null>(null);
  const [available, setAvailable] = useState<ActiveWarehouse[]>([]);
  const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Load the persisted choice and the live list together. The list is
      // authoritative: a persisted warehouse that no longer exists (deleted, or
      // the device moved operators) must not stick around silently scoping
      // queries to a dead id.
      const [raw, listRes] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        supabase
          .from('warehouses')
          .select('*')
          .order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;

      const list = ((listRes.data ?? []) as Array<ActiveWarehouse & { active?: boolean | null }>)
        .filter((w) => w?.id && isWarehouseActive(w));
      setAvailable(list);

      let chosen: ActiveWarehouse | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<ActiveWarehouse>;
          // Re-resolve against the live list so the NAME is fresh too (a rename
          // shouldn't leave a stale label on the header button).
          chosen = list.find((w) => w.id === parsed?.id) ?? null;
        } catch {
          // Corrupt entry — fall through to the auto-select / prompt below.
        }
      }

      // One warehouse = no decision to make. Auto-select so single-location
      // operators never see a picker and nothing changes for them.
      if (!chosen && list.length === 1) chosen = list[0]!;

      setWarehouse(chosen);
      // Prompt immediately when there IS a choice and none has been made —
      // better than opening onto an ambiguous bin list.
      if (!chosen && list.length > 1) setSwitcherOpen(true);
      setReady(true);
    })().catch(() => {
      // Offline / query failure: come up ready with no selection rather than
      // hanging on a spinner. Screens degrade to "pick a location".
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const select = useCallback((w: ActiveWarehouse) => {
    setWarehouse(w);
    setSwitcherOpen(false);
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  }, []);

  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  return (
    <WarehouseContext.Provider
      value={{
        warehouse,
        available,
        ready,
        multiLocation: available.length > 1,
        select,
        switcherOpen,
        openSwitcher,
        closeSwitcher,
      }}
    >
      {children}
    </WarehouseContext.Provider>
  );
}

export function useWarehouse(): WarehouseContextValue {
  return useContext(WarehouseContext);
}
