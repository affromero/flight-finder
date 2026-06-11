/**
 * Theme families. Each family is one colour identity with a matching light AND
 * dark palette (defined in styles/globals.css as `[data-theme='<family>-light']`
 * and `[data-theme='<family>-dark']`). A theme id is therefore `<family>-<mode>`,
 * e.g. `tron-dark`. The user picks a family once; the light/dark toggle flips
 * between that family's two palettes instead of swapping to a generic shared
 * light/dark.
 */
export interface ThemeFamily {
  id: string;
  label: string;
  description: string;
  /** Accent of the family's light palette (for the picker swatch). */
  lightAccent: string;
  /** Accent of the family's dark palette (for the picker swatch). */
  darkAccent: string;
}

export const THEME_FAMILIES: readonly ThemeFamily[] = [
  { id: 'altitude', label: 'Altitude', description: 'Deep teal and warm cream', lightAccent: '#1a4a52', darkAccent: '#80a8a5' },
  { id: 'midnight', label: 'Midnight', description: 'Neutral blue, no glow', lightAccent: '#2563eb', darkAccent: '#60a5fa' },
  { id: 'cyberpunk', label: 'Cyberpunk', description: 'Hot pink neon', lightAccent: '#c0208e', darkAccent: '#ff4fd8' },
  { id: 'tron', label: 'Tron', description: 'Grid-lit cyan', lightAccent: '#0e7490', darkAccent: '#00d9ff' },
  { id: 'autumn', label: 'Autumn', description: 'Warm amber cabin lighting', lightAccent: '#c7681c', darkAccent: '#e08a3c' },
  { id: 'solar', label: 'Solar', description: 'Burnt red dusk', lightAccent: '#c1272d', darkAccent: '#ff6b57' },
] as const;

export type ThemeMode = 'light' | 'dark';
/** `<family>-<mode>`, validated by isThemeId. */
export type ThemeId = string;

export const DEFAULT_THEME: ThemeId = 'altitude-dark';

const FAMILY_IDS = new Set<string>(THEME_FAMILIES.map((f) => f.id));

/**
 * Flat list of every concrete theme (light + dark for each family). Kept so the
 * root-layout mode map and any enumerator stay in sync with the families.
 */
export const THEME_OPTIONS = THEME_FAMILIES.flatMap((f) => [
  { id: `${f.id}-light`, label: `${f.label} Light`, mode: 'light' as ThemeMode, accent: f.lightAccent },
  { id: `${f.id}-dark`, label: `${f.label} Dark`, mode: 'dark' as ThemeMode, accent: f.darkAccent },
]);

export function isThemeId(value: string | null | undefined): value is ThemeId {
  if (!value) return false;
  const match = /^(.+)-(light|dark)$/.exec(value);
  return !!match && FAMILY_IDS.has(match[1]!);
}

export function getThemeMode(theme: string): ThemeMode {
  return theme.endsWith('-light') ? 'light' : 'dark';
}

export function getThemeFamily(theme: string): string {
  return theme.replace(/-(light|dark)$/, '');
}

export function themeId(family: string, mode: ThemeMode): ThemeId {
  return `${family}-${mode}`;
}

export function getFamily(id: string): ThemeFamily | undefined {
  return THEME_FAMILIES.find((f) => f.id === getThemeFamily(id));
}

export function getThemeFromDom(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const current = document.documentElement.getAttribute('data-theme');
  return isThemeId(current) ? current : DEFAULT_THEME;
}

export const THEME_CHANGE_EVENT = 'ft-theme-change';

export function applyTheme(theme: ThemeId) {
  if (typeof document === 'undefined') return;
  const mode = getThemeMode(theme);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme-mode', mode);
  // Broadcast so other controls (the nav light/dark toggle) stay in sync when
  // the theme is changed elsewhere (e.g. the appearance picker).
  document.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}

export function isLightTheme(theme: ThemeId) {
  return getThemeMode(theme) === 'light';
}

/** The same family in the opposite mode (what the light/dark toggle applies). */
export function getNextToggleTheme(theme: ThemeId): ThemeId {
  const family = getThemeFamily(theme);
  const safe = FAMILY_IDS.has(family) ? family : 'altitude';
  return themeId(safe, getThemeMode(theme) === 'light' ? 'dark' : 'light');
}

/**
 * Which theme to apply on a fresh page load.
 *
 * Self hosted: the theme is rendered server side into `<html data-theme>`
 * (the instance default, or the logged-in member's personal theme). The per
 * browser localStorage value must NOT override it, otherwise a stale value left
 * by an old toggle masks the real theme on pages that don't re-fetch config
 * (e.g. /q/[id]) -- issue #89's "theme keeps resetting" report. So the server
 * (DOM) wins.
 *
 * Hosted: anonymous visitors can't write the server config, so their per browser
 * toggle, persisted in localStorage, is the only place their preference lives
 * and therefore wins, falling back to the server default.
 */
export function resolveInitialTheme(opts: {
  selfHosted: boolean;
  localTheme: ThemeId | null;
  domTheme: ThemeId;
}): ThemeId {
  if (opts.selfHosted) return opts.domTheme;
  return opts.localTheme ?? opts.domTheme;
}
