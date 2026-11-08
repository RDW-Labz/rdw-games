import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EmployeeTrainingRow, Profile } from '@/lib/types';

export function useFloorData() {
  const [rows, setRows] = useState<EmployeeTrainingRow[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const reload = useCallback(async () => {
    const [r, p] = await Promise.all([api.training(), api.profiles()]);
    setRows(r);
    setProfiles(p);
  }, []);
  useEffect(() => {
    reload().catch(() => setRows([]));
  }, [reload]);
  return { rows, profiles, reload };
}
