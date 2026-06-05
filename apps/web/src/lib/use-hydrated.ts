'use client';

import { useState, useEffect } from 'react';

/**
 * Returns false during server rendering and the first client render, then true
 * after the component has mounted on the client.
 *
 * Gate any time-dependent rendering behind this so the server and the first
 * client render produce identical markup (no React hydration mismatch, #418),
 * then switch to the time-sensitive value after mount. Use it for:
 *   - absolute timestamps shown in the visitor's local timezone, and
 *   - relative "x minutes ago" strings derived from Date.now().
 * Both legitimately differ between the server clock/zone and the viewer's, so
 * they must be computed on the client.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
