import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBrowserArgs } from './browser';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildBrowserArgs', () => {
  it('keeps the single-process Docker workaround enabled by default', () => {
    vi.stubEnv('BROWSER_SINGLE_PROCESS', '');

    const args = buildBrowserArgs();

    expect(args).toContain('--single-process');
    expect(args).toContain('--in-process-gpu');
  });

  it('uses Chromium multi-process mode when BROWSER_SINGLE_PROCESS is false', () => {
    vi.stubEnv('BROWSER_SINGLE_PROCESS', 'false');

    const args = buildBrowserArgs();

    expect(args).not.toContain('--single-process');
    expect(args).not.toContain('--in-process-gpu');
    expect(args).toContain('--use-gl=angle');
    expect(args).toContain('--use-angle=swiftshader');
  });
});
