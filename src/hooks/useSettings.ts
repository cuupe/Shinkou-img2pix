import { useCallback, useState } from 'react';
import { DEFAULT_SETTINGS } from '../engine/types';
import type { Settings } from '../engine/types';
interface History { past: Settings[]; present: Settings; future: Settings[] }
export function useSettings() {
  const [history, setHistory] = useState<History>({ past: [], present: { ...DEFAULT_SETTINGS }, future: [] });
  const update = useCallback((patch: Partial<Settings>) => setHistory(h => {
    const next = { ...h.present, ...patch };
    if (JSON.stringify(next) === JSON.stringify(h.present)) return h;
    return { past: [...h.past.slice(-59), h.present], present: next, future: [] };
  }), []);
  const undo = useCallback(() => setHistory(h => h.past.length ? {
    past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future],
  } : h), []);
  const redo = useCallback(() => setHistory(h => h.future.length ? {
    past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1),
  } : h), []);
  const reset = useCallback(() => update({ ...DEFAULT_SETTINGS }), [update]);
  return { settings: history.present, update, undo, redo, reset, canUndo: !!history.past.length, canRedo: !!history.future.length };
}
