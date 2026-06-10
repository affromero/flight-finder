# Preset profile avatars

Generated illustrations served at `/avatars/{slug}.png`, one per entry in
`apps/web/src/lib/avatars.ts`. Until a PNG exists here (or if one fails to
load), the `Avatar` component falls back to the preset emoji on a themed tile,
so the feature works with no assets committed.

To generate the real images:

```bash
doppler run --project flight-finder --config dev -- node scripts/generate-avatars.mjs
```

Needs `GEMINI_API_KEY` (or `GOOGLE_AI_API_KEY`) in the environment. Override the
model with `GEMINI_IMAGE_MODEL`. The prompt and slugs live in the script.
