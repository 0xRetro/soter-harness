import { useCallback, useEffect, useState } from 'react';
import type { InspectionSnapshot } from './types';

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (initial = false) => {
    initial ? setLoading(true) : setRefreshing(true);
    try {
      const next = initial
        ? await window.soterStudio.getWorkspaceSnapshot()
        : await window.soterStudio.refreshWorkspaceSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    return window.soterStudio.onWorkspaceInvalidated(() => void refresh(false));
  }, [refresh]);

  return { snapshot, loading, refreshing, error, refresh: () => refresh(false) };
}
