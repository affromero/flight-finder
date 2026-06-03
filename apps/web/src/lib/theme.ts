export const THEME_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Altitude · deep teal and warm cream', mode: 'dark', accent: '#80a8a5' },
  { id: 'basic-light', label: 'Basic Light', description: 'Altitude cream with deep teal accents', mode: 'light', accent: '#1a4a52' },
  { id: 'basic-dark', label: 'Basic Dark', description: 'Neutral dark mode without the default glow', mode: 'dark', accent: '#60a5fa' },
  { id: 'cyberpunk', label: 'Cyberpunk', description: 'Hot pink neon and electric shadows', mode: 'dark', accent: '#ff4fd8' },
  { id: 'tron', label: 'Tron', description: 'Grid-lit cyan on deep blue', mode: 'dark', accent: '#00d9ff' },
  { id: 'autumn', label: 'Autumn', description: 'Warm amber cabin lighting', mode: 'light', accent: '#c7681c' },
  { id: 'solar-red', label: 'Solar Red', description: 'Burnt red dusk with bright highlights', mode: 'dark', accent: '#ff6b57' },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]['id'];
export type ThemeMode = (typeof THEME_OPTIONS)[number]['mode'];

const THEME_IDS = new Set<string>(THEME_OPTIONS.map((theme) => theme.id));

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return !!value && THEME_IDS.has(value);
}

export function getThemeMode(theme: ThemeId): ThemeMode {
  return THEME_OPTIONS.find((option) => option.id === theme)?.mode ?? 'dark';
}

export function getThemeFromDom(): ThemeId {
  if (typeof document === 'undefined') return 'default';
  const current = document.documentElement.getAttribute('data-theme');
  return isThemeId(current) ? current : 'default';
}

export function applyTheme(theme: ThemeId) {
  if (typeof document === 'undefined') return;
  const mode = getThemeMode(theme);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme-mode', mode);
}

export function isLightTheme(theme: ThemeId) {
  return getThemeMode(theme) === 'light';
}

/**
 * Which theme to apply on a fresh page load.
 *
 * Self hosted: the theme is a global instance setting saved server side
 * (ExtractionConfig), already rendered into `<html data-theme>`. The per browser
 * localStorage value must NOT override it, otherwise a stale value left by an old
 * toggle masks the real theme on pages that don't re-fetch config (e.g. /q/[id]),
 * which is issue #89's "theme keeps resetting" report. So the server (DOM) wins.
 *
 * Hosted: anonymous visitors can't write the server config, so their per browser
 * toggle, persisted in localStorage, is the only place their preference lives and
 * therefore wins, falling back to the server default.
 */
export function resolveInitialTheme(opts: {
  selfHosted: boolean;
  localTheme: ThemeId | null;
  domTheme: ThemeId;
}): ThemeId {
  if (opts.selfHosted) return opts.domTheme;
  return opts.localTheme ?? opts.domTheme;
}

export function getNextToggleTheme(theme: ThemeId, previousDarkTheme: ThemeId = 'default'): ThemeId {
  if (getThemeMode(theme) === 'light') {
    return getThemeMode(previousDarkTheme) === 'dark' ? previousDarkTheme : 'default';
  }

  return 'basic-light';
}
