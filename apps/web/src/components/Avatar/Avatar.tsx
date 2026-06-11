'use client';

import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { avatarImagePath, getAvatar } from '@/lib/avatars';
import styles from './Avatar.module.css';

interface AvatarProps {
  /** Preset avatar slug (see lib/avatars.ts), or null for the initials fallback. */
  slug?: string | null;
  /** Display name or username, used for initials and the accessible label. */
  name?: string | null;
  /** Rendered size in px (square). */
  size?: number;
  className?: string;
}

function initialsOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : trimmed.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A round profile avatar. Prefers the generated preset image; if it is missing
 * or fails to load, falls back to the preset emoji on its themed tile, and if
 * there is no preset, to the user's initials. Works with no image assets.
 */
export function Avatar({ slug, name, size = 40, className }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const preset = getAvatar(slug);
  const imgPath = avatarImagePath(slug);
  const label = preset?.name ?? name ?? 'avatar';

  // The image is server-rendered, so a 404 (e.g. the preset PNGs aren't
  // generated yet) can fire before React hydrates and attaches onError. Catch
  // that already-failed case on mount so we fall back to the emoji tile instead
  // of leaving a broken image.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      setImgFailed(true);
    }
  }, [imgPath]);

  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
    '--avatar-hue': preset?.hue ?? '#1a4a52',
  } as CSSProperties;

  if (imgPath && !imgFailed) {
    return (
      <span className={`${styles.root} ${className ?? ''}`} style={style}>
        {/* Static public asset with an onError emoji fallback; next/image cannot express that. */}
        <img
          ref={imgRef}
          src={imgPath}
          alt={label}
          className={styles.img}
          width={size}
          height={size}
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={`${styles.root} ${styles.tile} ${className ?? ''}`}
      style={style}
      role="img"
      aria-label={label}
    >
      {preset ? (
        <span className={styles.emoji} aria-hidden="true">
          {preset.emoji}
        </span>
      ) : (
        <span className={styles.initials} aria-hidden="true">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
