'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Grouping = 'airline' | 'flight';
interface ChartView {
  grouping: Grouping;
  hidden: string[];
}
const EMPTY_VIEW: ChartView = { grouping: 'airline', hidden: [] };
const CHANGE_EVENT = 'ft-chart-view-change';
const storageKey = (id: string) => `ft-chart-view:${id}`;

function decodeView(value: unknown): ChartView {
  if (!value || typeof value !== 'object') return EMPTY_VIEW;
  const data = value as Record<string, unknown>;
  if (data.grouping !== 'airline' && data.grouping !== 'flight') return EMPTY_VIEW;
  if (!Array.isArray(data.hidden) || !data.hidden.every(key => typeof key === 'string')) return EMPTY_VIEW;
  return { grouping: data.grouping, hidden: data.hidden };
}

function readView(id: string): ChartView {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw ? decodeView(JSON.parse(raw)) : EMPTY_VIEW;
  } catch {
    return EMPTY_VIEW;
  }
}

/** Local display preferences never alter tracker criteria or stored observations. */
export function useTrackerChartView(trackerId?: string) {
  const [state, setState] = useState({ trackerId, view: EMPTY_VIEW });
  const current = state.trackerId === trackerId ? state.view : EMPTY_VIEW;
  const latest = useRef(current);

  useEffect(() => {
    const update = (view: ChartView) => {
      latest.current = view;
      setState({ trackerId, view });
    };
    update(trackerId ? readView(trackerId) : EMPTY_VIEW);
    if (!trackerId) return;
    const onChange = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;
      const change = detail as { id: string; view: ChartView };
      if (change.id === trackerId) update(decodeView(change.view));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey(trackerId) || event.key === null) update(readView(trackerId));
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [trackerId]);

  const changeView = useCallback((change: (view: ChartView) => ChartView) => {
    const next = change(latest.current);
    latest.current = next;
    setState({ trackerId, view: next });
    if (!trackerId) return;
    try { localStorage.setItem(storageKey(trackerId), JSON.stringify(next)); } catch { /* Optional browser storage may be unavailable. */ }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { id: trackerId, view: next } }));
  }, [trackerId]);

  const setGrouping = useCallback((grouping: Grouping) => changeView(view => ({ ...view, grouping })), [changeView]);
  const toggle = useCallback((key: string) => changeView(view => ({
    ...view,
    hidden: view.hidden.includes(key) ? view.hidden.filter(item => item !== key) : [...view.hidden, key],
  })), [changeView]);
  const showAll = useCallback(() => changeView(view => ({ ...view, hidden: [] })), [changeView]);
  const isolate = useCallback((key: string, keys: string[]) => changeView(view => ({
    ...view, hidden: [...new Set(keys.filter(item => item !== key))],
  })), [changeView]);

  return { grouping: current.grouping, hidden: current.hidden, setGrouping, toggle, showAll, isolate };
}
