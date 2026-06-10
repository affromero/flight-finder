'use client';

import { FLIGHT_AVATARS } from '@/lib/avatars';
import { Avatar } from '@/components/Avatar/Avatar';
import styles from './AvatarPicker.module.css';

interface AvatarPickerProps {
  /** Currently selected preset slug, or null for the initials fallback. */
  value: string | null;
  onChange: (slug: string | null) => void;
  /** Name/username, so the initials option previews correctly. */
  name?: string | null;
  size?: number;
}

/** A grid of preset avatars plus an initials option, for account/admin/setup. */
export function AvatarPicker({ value, onChange, name, size = 72 }: AvatarPickerProps) {
  return (
    <div className={styles.root} role="radiogroup" aria-label="Choose a profile avatar">
      <button
        type="button"
        className={`${styles.option} ${value === null ? styles.selected : ''}`}
        onClick={() => onChange(null)}
        role="radio"
        aria-checked={value === null}
        title="Initials"
      >
        <Avatar slug={null} name={name} size={size} />
      </button>
      {FLIGHT_AVATARS.map((a) => (
        <button
          key={a.slug}
          type="button"
          className={`${styles.option} ${value === a.slug ? styles.selected : ''}`}
          onClick={() => onChange(a.slug)}
          role="radio"
          aria-checked={value === a.slug}
          title={a.name}
        >
          <Avatar slug={a.slug} name={name} size={size} />
        </button>
      ))}
    </div>
  );
}
