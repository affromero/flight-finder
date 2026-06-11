'use client';

import { useEffect, useState } from 'react';
import styles from './ThemeToggle.module.css';
import { applyTheme, getNextToggleTheme, getThemeFromDom, getThemeMode, isThemeId, resolveInitialTheme, THEME_CHANGE_EVENT, DEFAULT_THEME, type ThemeId } from '@/lib/theme';

const LOCAL_THEME_KEY = 'ft-theme';

declare global {
  interface Window {
    // Set by the theme bootstrap in the root layout. True on self hosted
    // instances, where the global server theme wins over per browser localStorage.
    __ftSelfHosted?: boolean;
    // True when a multi user member is logged in: the theme is their personal
    // setting (User.theme), saved per user instead of as the instance default.
    __ftPerUserTheme?: boolean;
  }
}

function isSelfHostedClient(): boolean {
  return typeof window !== 'undefined' && window.__ftSelfHosted === true;
}

function isPerUserThemeClient(): boolean {
  return typeof window !== 'undefined' && window.__ftPerUserTheme === true;
}

function readLocalTheme(): ThemeId | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage?.getItem?.(LOCAL_THEME_KEY);
    return isThemeId(v) ? v : null;
  } catch {
    return null;
  }
}

function writeLocalTheme(theme: ThemeId) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem?.(LOCAL_THEME_KEY, theme);
  } catch {
    // Privacy mode or quota: theme stays in memory only for this session.
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Hosted: prefer the per-browser preference so a visitor's toggle sticks
    // across reloads even when the server-side save is rejected (admin only).
    // Self hosted: the global server theme already on the DOM wins, so a stale
    // localStorage value can't override it (issue #89).
    const resolved = resolveInitialTheme({
      selfHosted: isSelfHostedClient(),
      localTheme: readLocalTheme(),
      domTheme: getThemeFromDom(),
    });
    setTheme(resolved);
    applyTheme(resolved);
  }, []);

  // Stay in sync when the theme changes elsewhere (the appearance picker), so
  // the toggle flips within whatever family is now selected.
  useEffect(() => {
    const onChange = (e: Event) => {
      const t = (e as CustomEvent<ThemeId>).detail;
      if (isThemeId(t)) setTheme(t);
    };
    document.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => document.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  const toggle = async () => {
    if (saving) return;
    // Flip light<->dark within the current family (keeps the colour identity).
    const next = getNextToggleTheme(theme);
    const prev = theme;
    setTheme(next);
    applyTheme(next);
    writeLocalTheme(next);
    setSaving(true);

    try {
      // Logged-in members save their personal theme (User.theme); otherwise the
      // toggle writes the instance default (admin/self-hosted-solo) or, for an
      // anonymous hosted visitor, just localStorage.
      const endpoint = isPerUserThemeClient() ? '/api/account/settings' : '/api/admin/config';
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
      if (res.status === 401 || res.status === 403) {
        // Visitor isn't admin (hosted mode). Local theme already applied
        // and saved to localStorage. Nothing to roll back.
        return;
      }
      const data = await res.json();
      if (!data.ok) {
        setTheme(prev);
        applyTheme(prev);
        writeLocalTheme(prev);
      }
    } catch {
      // Network error: keep the locally applied theme.
    } finally {
      setSaving(false);
    }
  };

  return (
    <button className={styles.toggle} onClick={toggle} aria-label="Toggle theme" disabled={saving}>
      {getThemeMode(theme) === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
