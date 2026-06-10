/**
 * Preset profile avatars for multi user mode: flight and travel motifs in the
 * Altitude palette. Each has a generated illustration at /avatars/{slug}.png.
 * Until those images exist (or if one fails to load), the picker falls back to
 * the emoji on a themed gradient tile, so the feature works fully offline with
 * no assets.
 *
 * To generate the real images, run scripts/generate-avatars.mjs with a Gemini
 * key. The prompt and slugs live there and mirror this list.
 */

export interface FlightAvatar {
  slug: string;
  name: string;
  /** Fallback glyph shown until the generated image exists (or if it 404s). */
  emoji: string;
  /** Altitude-harmonized accent for the fallback tile gradient. */
  hue: string;
}

export const FLIGHT_AVATARS: FlightAvatar[] = [
  { slug: 'paper-plane', name: 'Paper Plane', emoji: '✈️', hue: '#1a4a52' },
  { slug: 'departure', name: 'Departure', emoji: '🛫', hue: '#2f8f7f' },
  { slug: 'arrival', name: 'Arrival', emoji: '🛬', hue: '#3a5a64' },
  { slug: 'globe', name: 'Globe', emoji: '🌍', hue: '#2a6f97' },
  { slug: 'compass', name: 'Compass', emoji: '🧭', hue: '#d4a574' },
  { slug: 'suitcase', name: 'Suitcase', emoji: '🧳', hue: '#a87b3c' },
  { slug: 'boarding-pass', name: 'Boarding Pass', emoji: '🎫', hue: '#c1272d' },
  { slug: 'passport', name: 'Passport', emoji: '📘', hue: '#2a4a7a' },
  { slug: 'window-seat', name: 'Window Seat', emoji: '💺', hue: '#5a9aa8' },
  { slug: 'world-map', name: 'World Map', emoji: '🗺️', hue: '#b8703a' },
];

const BY_SLUG = new Map(FLIGHT_AVATARS.map((a) => [a.slug, a]));

/** The image path for a preset slug, or null for an unknown/unset value. */
export function avatarImagePath(slug: string | null | undefined): string | null {
  return slug && BY_SLUG.has(slug) ? `/avatars/${slug}.png` : null;
}

export function isPresetSlug(value: unknown): value is string {
  return typeof value === 'string' && BY_SLUG.has(value);
}

export function getAvatar(slug: string | null | undefined): FlightAvatar | undefined {
  return slug ? BY_SLUG.get(slug) : undefined;
}
