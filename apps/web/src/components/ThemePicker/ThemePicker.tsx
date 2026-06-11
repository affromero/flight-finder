'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
  THEME_FAMILIES,
  applyTheme,
  getThemeFromDom,
  getThemeFamily,
  getThemeMode,
  isThemeId,
  themeId,
  DEFAULT_THEME,
  type ThemeId,
  type ThemeMode,
} from '@/lib/theme';
import styles from './ThemePicker.module.css';

/**
 * One selection per colour family, plus a Light/Dark switch. Each family has a
 * matching light and dark palette; the swatch shows both halves so you can see
 * what "light" and "dark" look like for that colour. Choosing a family or
 * flipping the switch applies the theme immediately and calls onSelect so the
 * parent can persist it.
 */
export function ThemePicker({
  value,
  onSelect,
  defaultOption,
}: {
  /** Currently saved theme id (or null when following an external default). */
  value: ThemeId | null;
  onSelect: (id: ThemeId) => void;
  /** Optional "follow the instance default" escape hatch (per-user picker). */
  defaultOption?: { active: boolean; onSelect: () => void };
}) {
  const start = value && isThemeId(value) ? value : DEFAULT_THEME;
  const [family, setFamily] = useState(getThemeFamily(start));
  const [mode, setMode] = useState<ThemeMode>(getThemeMode(start));

  // With no concrete value (following an external default) sync the highlight to
  // whatever theme is actually rendered. A concrete value is trusted as-is.
  useEffect(() => {
    if (value && isThemeId(value)) return;
    const dom = getThemeFromDom();
    setFamily(getThemeFamily(dom));
    setMode(getThemeMode(dom));
  }, [value]);

  const choose = (fam: string, m: ThemeMode) => {
    const id = themeId(fam, m);
    setFamily(fam);
    setMode(m);
    applyTheme(id);
    onSelect(id);
  };

  const usingDefault = defaultOption?.active ?? false;

  return (
    <div className={styles.root}>
      <div className={styles.modeSwitch} role="group" aria-label="Light or dark">
        {(['light', 'dark'] as ThemeMode[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={!usingDefault && mode === m}
            className={`${styles.modeBtn} ${!usingDefault && mode === m ? styles.modeBtnActive : ''}`}
            onClick={() => choose(family, m)}
          >
            {m === 'light' ? '☀ Light' : '☾ Dark'}
          </button>
        ))}
      </div>

      <div className={styles.grid}>
        {THEME_FAMILIES.map((f) => {
          const active = !usingDefault && family === f.id;
          return (
            <button
              key={f.id}
              type="button"
              className={`${styles.card} ${active ? styles.cardActive : ''}`}
              onClick={() => choose(f.id, mode)}
            >
              <span
                className={styles.swatch}
                style={{ '--la': f.lightAccent, '--da': f.darkAccent } as CSSProperties}
                aria-hidden="true"
              />
              <span className={styles.swatchCaption} aria-hidden="true">
                <span>Light</span>
                <span>Dark</span>
              </span>
              <span className={styles.name}>{f.label}</span>
              <span className={styles.desc}>{f.description}</span>
            </button>
          );
        })}
      </div>

      {defaultOption && (
        <button
          type="button"
          className={`${styles.defaultBtn} ${usingDefault ? styles.defaultActive : ''}`}
          onClick={defaultOption.onSelect}
        >
          {usingDefault ? '✓ Following the instance default' : 'Follow the instance default instead'}
        </button>
      )}
    </div>
  );
}
