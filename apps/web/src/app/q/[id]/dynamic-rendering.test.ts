import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Issue #89: /q/[id] was the only primary page not marked force-dynamic. In
// self-hosted solo mode the page reads no dynamic request API, so Next.js cached
// it in the Full Route Cache, baking in the root layout's `<html data-theme>`.
// A theme change in /admin/config then never reached the tracker page until the
// cache regenerated, which read as "the theme keeps resetting on /q/[id]". The
// same staleness hid fresh prices. This guards the opt-out so the regression
// can't silently come back via a refactor that drops the export.
describe('q/[id] route rendering mode', () => {
  it('opts out of the Full Route Cache so theme and prices stay fresh', () => {
    const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(source).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
  });
});
