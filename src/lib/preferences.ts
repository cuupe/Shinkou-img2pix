export const PREFERENCES_KEY = 'shinkou.preferences:v1';
export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  accent: 'lime' | 'blue' | 'violet';
  reducedMotion: boolean;
  canvas: 'checker' | 'solid';
  exportFormat: 'png' | 'webp';
  exportScale: 1 | 2 | 4 | 8;
}
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system', accent: 'lime', reducedMotion: false, canvas: 'checker', exportFormat: 'png', exportScale: 4,
};

/** Whitelist persisted values: old or damaged preferences must never break startup. */
export function parsePreferences(raw: string | null): Preferences {
  const defaults = { ...DEFAULT_PREFERENCES };
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    const p = value as Record<string, unknown>;
    return {
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
      accent: p.accent === 'blue' || p.accent === 'violet' ? p.accent : 'lime',
      reducedMotion: p.reducedMotion === true,
      canvas: p.canvas === 'solid' ? 'solid' : 'checker',
      exportFormat: p.exportFormat === 'webp' ? 'webp' : 'png',
      exportScale: p.exportScale === 1 || p.exportScale === 2 || p.exportScale === 8 ? p.exportScale : 4,
    };
  } catch { return defaults; }
}
export function readPreferences(): Preferences {
  try { return parsePreferences(localStorage.getItem(PREFERENCES_KEY)); }
  catch { return { ...DEFAULT_PREFERENCES }; }
}
export function applyAppearance(preferences: Preferences, systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches) {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme === 'system' ? systemDark ? 'dark' : 'light' : preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.motion = preferences.reducedMotion ? 'reduce' : 'system';
  root.dataset.canvas = preferences.canvas;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', root.dataset.theme === 'dark' ? '#16181c' : '#f6f7f9');
}
