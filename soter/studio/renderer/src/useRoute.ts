import { useCallback, useEffect, useState } from 'react';
import type { ViewName } from './types';

function parseHash(): { view: ViewName; selectedId: string | null } {
  const [rawView, ...rawId] = window.location.hash.replace(/^#\/?/, '').split('/');
  const view: ViewName = rawView === 'operate' || rawView === 'config' || rawView === 'workflow' || rawView === 'runs' || rawView === 'distribution' ? rawView : 'explore';
  const selectedId = rawId.length ? decodeURIComponent(rawId.join('/')) : null;
  return { view, selectedId };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const update = () => setRoute(parseHash());
    window.addEventListener('hashchange', update);
    if (!window.location.hash) window.location.hash = '#/explore';
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = useCallback((view: ViewName, selectedId?: string | null) => {
    window.location.hash = '#/' + view + (selectedId ? '/' + encodeURIComponent(selectedId) : '');
  }, []);
  return { ...route, navigate };
}
