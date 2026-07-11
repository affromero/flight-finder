'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from '@/app/page.module.css';
import { getThemeFromDom, isLightTheme, isThemeId, type ThemeId } from '@/lib/theme';

export function DemoGif() {
  const t = useTranslations('DemoGif');
  const [theme, setTheme] = useState<ThemeId>('default');

  useEffect(() => {
    const el = document.documentElement;

    const syncTheme = () => {
      const currentTheme = el.getAttribute('data-theme');
      setTheme(isThemeId(currentTheme) ? currentTheme : getThemeFromDom());
    };

    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <img
      src={isLightTheme(theme) ? '/demo-light.gif' : '/demo-dark.gif'}
      alt={t('alt')}
      className={styles.demoImg}
      width={1280}
      height={900}
      loading="eager"
    />
  );
}
