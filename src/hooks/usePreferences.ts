import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { applyAppearance, DEFAULT_PREFERENCES, PREFERENCES_KEY, readPreferences } from '../lib/preferences';
import type { Preferences } from '../lib/preferences';

export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (current) return getCurrentWindow().setTheme(preferences.theme === 'system' ? null : preferences.theme);
    }).catch(error => console.warn('无法同步窗口主题', error));
    return () => { current = false; };
  }, [preferences.theme]);
  useEffect(() => {
    applyAppearance(preferences);
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      setStorageError(false);
    } catch { setStorageError(true); }
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyAppearance(preferences, system.matches);
    system.addEventListener('change', update);
    return () => system.removeEventListener('change', update);
  }, [preferences]);
  const updatePreferences = useCallback((patch: Partial<Preferences>) => setPreferences(p => ({ ...p, ...patch })), []);
  const resetPreferences = useCallback(() => setPreferences({ ...DEFAULT_PREFERENCES }), []);
  return { preferences, updatePreferences, resetPreferences, storageError };
}
