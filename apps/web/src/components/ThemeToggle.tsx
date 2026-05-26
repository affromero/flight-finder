'use client';

import { useEffect, useState } from 'react';
import styles from './ThemeToggle.module.css';
import { applyTheme, getNextToggleTheme, getThemeFromDom, getThemeMode, isLightTheme, isThemeId, type ThemeId } from '@/lib/theme';

const LOCAL_THEME_KEY = 'ft-theme';

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
  const [theme, setTheme] = useState<ThemeId>('default');
  const [lastDarkTheme, setLastDarkTheme] = useState<ThemeId>('default');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Prefer per-browser preference over server-side default so a visitor's
    // toggle sticks across reloads even in hosted mode where /api/admin/config
    // requires admin auth and the server-side save is rejected.
    const resolved = readLocalTheme() ?? getThemeFromDom();
    setTheme(resolved);
    setLastDarkTheme(isLightTheme(resolved) ? 'default' : resolved);
    applyTheme(resolved);
  }, []);

  const toggle = async () => {
    if (saving) return;
    const next: ThemeId = getNextToggleTheme(theme, lastDarkTheme);
    const nextDarkTheme = isLightTheme(theme) ? next : theme;
    setTheme(next);
    setLastDarkTheme(nextDarkTheme);
    applyTheme(next);
    writeLocalTheme(next);
    setSaving(true);

    try {
      const res = await fetch('/api/admin/config', {
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
        setTheme(theme);
        setLastDarkTheme(lastDarkTheme);
        applyTheme(theme);
        writeLocalTheme(theme);
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
