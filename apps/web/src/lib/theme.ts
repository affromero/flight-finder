export const THEME_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Current Flight Finder look', mode: 'dark', accent: '#06b6d4' },
  { id: 'basic-light', label: 'Basic Light', description: 'Clean high-contrast light mode', mode: 'light', accent: '#0891b2' },
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

export function getNextToggleTheme(theme: ThemeId, previousDarkTheme: ThemeId = 'default'): ThemeId {
  if (getThemeMode(theme) === 'light') {
    return getThemeMode(previousDarkTheme) === 'dark' ? previousDarkTheme : 'default';
  }

  return 'basic-light';
}
