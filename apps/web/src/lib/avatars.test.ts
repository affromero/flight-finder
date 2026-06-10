import { describe, it, expect } from 'vitest';
import {
  FLIGHT_AVATARS,
  avatarImagePath,
  isPresetSlug,
  getAvatar,
} from './avatars';

describe('avatars', () => {
  it('has unique slugs and complete entries', () => {
    const slugs = FLIGHT_AVATARS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const a of FLIGHT_AVATARS) {
      expect(a.slug).toMatch(/^[a-z-]+$/);
      expect(a.name).toBeTruthy();
      expect(a.emoji).toBeTruthy();
      expect(a.hue).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('maps a known slug to its public image path', () => {
    expect(avatarImagePath('paper-plane')).toBe('/avatars/paper-plane.png');
  });

  it('returns null for unknown, empty, null, or undefined slugs', () => {
    expect(avatarImagePath('not-a-real-slug')).toBeNull();
    expect(avatarImagePath('')).toBeNull();
    expect(avatarImagePath(null)).toBeNull();
    expect(avatarImagePath(undefined)).toBeNull();
  });

  it('isPresetSlug only accepts known string slugs', () => {
    expect(isPresetSlug('globe')).toBe(true);
    expect(isPresetSlug('nope')).toBe(false);
    expect(isPresetSlug(null)).toBe(false);
    expect(isPresetSlug(42)).toBe(false);
    expect(isPresetSlug({ slug: 'globe' })).toBe(false);
  });

  it('getAvatar resolves a preset and is undefined otherwise', () => {
    expect(getAvatar('compass')?.name).toBe('Compass');
    expect(getAvatar('nope')).toBeUndefined();
    expect(getAvatar(null)).toBeUndefined();
  });
});
