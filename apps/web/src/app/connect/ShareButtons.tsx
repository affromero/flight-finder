'use client';

import { useState, useEffect } from 'react';
import styles from './page.module.css';

const MESSAGE = 'Track flight prices with me on Flight Finder';

export function ShareButtons({ url }: { url: string }) {
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const enc = encodeURIComponent;

  const nativeShare = async () => {
    try {
      await navigator.share({ title: 'Flight Finder', text: MESSAGE, url });
    } catch {
      // User dismissed the share sheet; nothing to do.
    }
  };

  return (
    <div className={styles.share}>
      {canShare && (
        // The native sheet covers Signal, WhatsApp, Telegram, and whatever else
        // the device has installed -- the explicit links below are the desktop
        // fallback where navigator.share is unavailable.
        <button type="button" className={styles.shareNative} onClick={nativeShare}>
          Share…
        </button>
      )}
      <a
        className={styles.shareBtn}
        href={`https://wa.me/?text=${enc(`${MESSAGE} ${url}`)}`}
        target="_blank"
        rel="noreferrer"
      >
        WhatsApp
      </a>
      <a
        className={styles.shareBtn}
        href={`https://t.me/share/url?url=${enc(url)}&text=${enc(MESSAGE)}`}
        target="_blank"
        rel="noreferrer"
      >
        Telegram
      </a>
      <a className={styles.shareBtn} href={`mailto:?subject=${enc('Flight Finder')}&body=${enc(`${MESSAGE}: ${url}`)}`}>
        Email
      </a>
    </div>
  );
}
