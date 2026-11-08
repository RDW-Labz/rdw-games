// useLoadsList — fetch active loads for the current operator.
//
// W9 slice 3 / mig 0148: reads from the `loads` table introduced by the
// W9 slice 3 PR (#73). Field-mobile is READ-ONLY per resolved decision D8;
// only managers (operator-web) can create/archive loads.
//
// Returns up to 50 most-recently-created active loads (archived_at IS NULL).
// Used by the LotTR hub source picker to let operators tag lots with a
// structured load instead of a freeform source string.

import { useEffect, useState } from 'react';
import { supabase } from '@auction-platform/supabase-client';

export type LoadRow = {
  id: string;
  source_name: string;
  type: 'auto-import' | 'manual';
  /** Loads share names (the daily Wayfair job makes a "wayfair-d2l" every
   *  morning), so the picker shows the date to tell them apart (#533). */
  created_at: string;
};

export type LoadsListState =
  | { status: 'loading' }
  | { status: 'ok'; loads: LoadRow[] }
  | { status: 'error'; message: string };

export function useLoadsList(): LoadsListState {
  const [state, setState] = useState<LoadsListState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase
          .from('loads')
          .select('id, source_name, type, created_at')
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(50);

        if (cancelled) return;

        if (error) {
          setState({ status: 'error', message: error.message });
          return;
        }

        setState({
          status: 'ok',
          loads: (data ?? []) as LoadRow[],
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          message: (err as Error).message ?? 'Failed to load loads list.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
