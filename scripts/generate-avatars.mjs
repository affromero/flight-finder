#!/usr/bin/env node
/*
 * Generate the flight-themed profile avatars with a Gemini image model. They
 * drop into apps/web/public/avatars/, replacing the emoji fallback tiles
 * automatically (the picker prefers /avatars/{slug}.png when present).
 *
 * Run once a key is available, for example through Doppler:
 *   doppler run --project flight-finder --config dev -- node scripts/generate-avatars.mjs
 *
 * Needs GEMINI_API_KEY (Sotto's var name) or GOOGLE_AI_API_KEY (this project's
 * existing var) in the environment. Optional GEMINI_IMAGE_MODEL override.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
if (!KEY) {
  console.error(
    'No image key found. Set GEMINI_API_KEY or GOOGLE_AI_API_KEY (add it to the flight-finder Doppler config).',
  );
  process.exit(1);
}

const MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image-preview';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'avatars');
mkdirSync(OUT, { recursive: true });

// Altitude design system: vintage travel poster, Pan Am / French Line ocean
// liner heritage. Deep teal and warm cream with a scarlet alert accent.
const STYLE =
  'A circular medallion badge, vintage mid-century travel-poster style, Pan Am and French Line ' +
  'ocean liner heritage, bold screen-print texture. The design is a perfect CIRCLE that fills the ' +
  'whole square frame edge to edge (a round emblem / porthole / fisheye view), with the icon ' +
  'centered inside the circle on a warm cream #faf6ed disc. Everything outside the circle is solid ' +
  'cream #faf6ed so it disappears when cropped round. Deep teal #1a4a52 with muted gold #d4a574 ' +
  'accents and an occasional scarlet #c1272d highlight. Refined, elegant, simple. ' +
  'No text, no words, no letters, no logos.';

const SUBJECTS = [
  ['paper-plane', 'a folded paper airplane in flight'],
  ['departure', 'an airliner taking off into the sky'],
  ['arrival', 'an airliner coming in to land over a runway'],
  ['globe', 'a vintage globe of the earth'],
  ['compass', 'a brass travel compass'],
  ['suitcase', 'a vintage leather travel suitcase with stickers'],
  ['boarding-pass', 'a vintage airline boarding pass'],
  ['passport', 'a travel passport booklet'],
  ['window-seat', 'a view of clouds through an airplane window'],
  ['world-map', 'a vintage world travel route map'],
];

let ok = 0;
for (const [slug, subject] of SUBJECTS) {
  const prompt = `An illustration of ${subject}. ${STYLE}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      },
    );
    const data = await res.json();
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) {
      console.error(`${slug}: no image returned`, JSON.stringify(data).slice(0, 200));
      continue;
    }
    writeFileSync(join(OUT, `${slug}.png`), Buffer.from(part.inlineData.data, 'base64'));
    console.log(`${slug}.png written`);
    ok += 1;
  } catch (err) {
    console.error(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nDone: ${ok}/${SUBJECTS.length} avatars written to ${OUT}`);
if (ok < SUBJECTS.length) process.exit(1);
