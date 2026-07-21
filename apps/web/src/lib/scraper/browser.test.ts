import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBrowserArgs } from './browser';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildBrowserArgs', () => {
  it('uses Chromium multi-process mode by default for native and desktop hosts', () => {
    vi.stubEnv('BROWSER_SINGLE_PROCESS', '');

    const args = buildBrowserArgs();

    expect(args).not.toContain('--single-process');
    expect(args).not.toContain('--in-process-gpu');
  });

  it('enables the single-process Docker workaround when explicitly configured', () => {
    vi.stubEnv('BROWSER_SINGLE_PROCESS', 'true');

    const args = buildBrowserArgs();

    expect(args).toContain('--single-process');
    expect(args).toContain('--in-process-gpu');
    expect(args).toContain('--use-gl=angle');
    expect(args).toContain('--use-angle=swiftshader');
  });
});
