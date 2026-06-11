import { describe, it, expect } from 'vitest';
import {
  resolveInitialTheme,
  isThemeId,
  getThemeMode,
  getThemeFamily,
  getNextToggleTheme,
  themeId,
  THEME_FAMILIES,
} from './theme';

// Issue #89: on self hosted instances the theme is a server setting rendered
// into <html data-theme>. A stale localStorage value from an old toggle was
// overriding it on /q/[id] (which never re-fetches config to self correct), so
// the page kept showing the wrong theme on cold loads.
describe('resolveInitialTheme', () => {
  it('self hosted: the server (DOM) theme wins, ignoring any localStorage value', () => {
    expect(
      resolveInitialTheme({ selfHosted: true, localTheme: 'cyberpunk-dark', domTheme: 'autumn-light' }),
    ).toBe('autumn-light');
  });

  it('self hosted: still uses the server theme when localStorage is empty', () => {
    expect(
      resolveInitialTheme({ selfHosted: true, localTheme: null, domTheme: 'tron-dark' }),
    ).toBe('tron-dark');
  });

  it('hosted: the per browser localStorage preference wins', () => {
    expect(
      resolveInitialTheme({ selfHosted: false, localTheme: 'cyberpunk-dark', domTheme: 'altitude-dark' }),
    ).toBe('cyberpunk-dark');
  });

  it('hosted: falls back to the server default when there is no localStorage preference', () => {
    expect(
      resolveInitialTheme({ selfHosted: false, localTheme: null, domTheme: 'altitude-light' }),
    ).toBe('altitude-light');
  });
});

describe('theme families', () => {
  it('isThemeId accepts every family in both modes', () => {
    for (const f of THEME_FAMILIES) {
      expect(isThemeId(`${f.id}-light`)).toBe(true);
      expect(isThemeId(`${f.id}-dark`)).toBe(true);
    }
  });

  it('isThemeId rejects the legacy flat ids and garbage', () => {
    for (const legacy of ['default', 'basic-light', 'basic-dark', 'cyberpunk', 'tron', 'autumn', 'solar-red']) {
      expect(isThemeId(legacy)).toBe(false);
    }
    expect(isThemeId('tron-purple')).toBe(false);
    expect(isThemeId('nope-dark')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId('')).toBe(false);
  });

  it('getThemeMode and getThemeFamily split a theme id', () => {
    expect(getThemeMode('tron-light')).toBe('light');
    expect(getThemeMode('tron-dark')).toBe('dark');
    expect(getThemeFamily('cyberpunk-dark')).toBe('cyberpunk');
    expect(getThemeFamily('altitude-light')).toBe('altitude');
  });

  it('getNextToggleTheme flips light<->dark within the same family', () => {
    expect(getNextToggleTheme('tron-dark')).toBe('tron-light');
    expect(getNextToggleTheme('tron-light')).toBe('tron-dark');
    expect(getNextToggleTheme('solar-dark')).toBe('solar-light');
  });

  it('themeId composes a family and mode', () => {
    expect(themeId('midnight', 'dark')).toBe('midnight-dark');
    expect(themeId('autumn', 'light')).toBe('autumn-light');
  });
});
