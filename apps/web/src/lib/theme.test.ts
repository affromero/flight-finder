import { describe, it, expect } from 'vitest';
import { resolveInitialTheme } from './theme';

// Issue #89: on self hosted instances the theme is a global server setting
// rendered into <html data-theme>. A stale localStorage value from an old toggle
// was overriding it on /q/[id] (which, unlike the admin pages, never re-fetches
// config to self correct), so the page kept showing the wrong theme on cold loads.
describe('resolveInitialTheme', () => {
  it('self hosted: the server (DOM) theme wins, ignoring any localStorage value', () => {
    expect(
      resolveInitialTheme({ selfHosted: true, localTheme: 'cyberpunk', domTheme: 'autumn' }),
    ).toBe('autumn');
  });

  it('self hosted: still uses the server theme when localStorage is empty', () => {
    expect(
      resolveInitialTheme({ selfHosted: true, localTheme: null, domTheme: 'tron' }),
    ).toBe('tron');
  });

  it('hosted: the per browser localStorage preference wins', () => {
    expect(
      resolveInitialTheme({ selfHosted: false, localTheme: 'cyberpunk', domTheme: 'default' }),
    ).toBe('cyberpunk');
  });

  it('hosted: falls back to the server default when there is no localStorage preference', () => {
    expect(
      resolveInitialTheme({ selfHosted: false, localTheme: null, domTheme: 'basic-light' }),
    ).toBe('basic-light');
  });
});
